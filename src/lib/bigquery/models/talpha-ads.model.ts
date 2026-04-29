import * as fs from "fs";
import * as yaml from "js-yaml";
import * as path from "path";
import { runQuery, BQ_DATASET } from "../client";

const YAML_PATH = path.resolve(process.cwd(), "config/projects/talpha.yaml");

export interface TAlphaConfig {
    meta_ads: { access_token: string; ad_account_ids: string[] };
    poscake: { shops: Array<{ name: string; api_url: string; api_key: string; shop_id: string }>; shop_ids: string[] };
    exchange_rates: Array<{ from: string; to: string; rate: number }>;
    marketer_map?: Array<{ pos_name: string; campaign_key: string }>;
}

export interface TAlphaOrder {
    id: string;
    shop_name: string;
    ad_id: string | null;
    marketer: string;
    total_price_local: number;
    total_price_vnd: number;
    status: string;
    inserted_at: string;
    customer_name: string;
}

/**
 * ALL 21 TALPHA ad accounts use VND currency (confirmed via Meta API query).
 * Meta API returns spend already in VND → NO conversion needed (rate = 1).
 */

export class TAlphaAdsModel {
    static loadConfig(): TAlphaConfig {
        const raw = fs.readFileSync(YAML_PATH, "utf-8");
        return yaml.load(raw) as TAlphaConfig;
    }

    static getExchangeRate(currency: string): number {
        if (currency === "VND") return 1;
        const cfg = this.loadConfig();
        const rateObj = cfg.exchange_rates.find(r => r.from === currency);
        return rateObj ? rateObj.rate : 7000;
    }

    /**
     * Fetch ALL pages from Meta Ads API (handles pagination).
     * Meta API returns max ~25-500 results per page.
     */
    static async fetchAllPages(initialUrl: string): Promise<any[]> {
        const allData: any[] = [];
        let url: string | null = initialUrl;
        let pageCount = 0;

        while (url && pageCount < 20) { // Safety limit: max 20 pages
            try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 15000); // 15s timeout per page
                const res = await fetch(url, { signal: controller.signal });
                clearTimeout(timeout);
                const json: any = await res.json();

                if (json.error) {
                    console.error("Meta API Error:", json.error.message, json.error.code);
                    break;
                }

                if (json.data) {
                    allData.push(...json.data);
                } else {
                    console.error("Meta API no data field:", JSON.stringify(json).slice(0, 200));
                }

                url = json.paging?.next || null;
                pageCount++;
            } catch (e: any) {
                if (e.name === 'AbortError') {
                    console.error("Meta Ads fetch timeout, continuing...");
                } else {
                    console.error("Meta Ads fetch error:", e);
                }
                break;
            }
        }
        return allData;
    }

    /**
     * Fetch all ads (catalog) for an account — no date filter.
     * Returns: ad_id → { campaign_id, campaign_name, account_id }
     * Used to match POS orders even when the ad has no spend today.
     */
    static async fetchAdCatalog(accId: string, access_token: string): Promise<Record<string, { campaign_id: string; campaign_name: string; account_id: string }>> {
        const catalog: Record<string, { campaign_id: string; campaign_name: string; account_id: string }> = {};
        try {
            const url = `https://graph.facebook.com/v21.0/${accId}/ads?fields=id,campaign_id,campaign{id,name}&limit=500&access_token=${access_token}`;
            const rows = await this.fetchAllPages(url);
            rows.forEach((row: any) => {
                const adId = String(row.id || '');
                const campaignId = String(row.campaign_id || row.campaign?.id || '');
                const campaignName = row.campaign?.name || '';
                if (adId && campaignId) {
                    catalog[adId] = { campaign_id: campaignId, campaign_name: campaignName, account_id: accId };
                }
            });
        } catch (e) {
            console.error(`Ad catalog Error (${accId}):`, e);
        }
        return catalog;
    }

    /**
     * Fetch Meta Ads with ALL required metrics:
     * spend, purchases, conversion_value, messages, comments,
     * impressions, reach (for CPM, frequency, ROAS calculation)
     */
    static async fetchMetaAds(fromDate: string, toDate: string) {
        const cfg = this.loadConfig();
        const { access_token, ad_account_ids } = cfg.meta_ads;
        const allAds: any[] = [];
        const allCatalog: Record<string, { campaign_id: string; campaign_name: string; account_id: string }> = {};
        const metaErrors: string[] = [];
        const timeRange = `&time_range=${encodeURIComponent(JSON.stringify({ since: fromDate, until: toDate }))}`;

        // Fields to request from Meta API
        const fields = [
            "campaign_name", "campaign_id", "ad_id", "adset_name",
            "spend", "impressions", "reach",
            "actions", "action_values",
            "cost_per_action_type"
        ].join(",");
        await Promise.all(ad_account_ids.map(async (accId) => {
            try {
                const url = `https://graph.facebook.com/v21.0/${accId}/insights?fields=${fields}&level=ad&limit=500${timeRange}&access_token=${access_token}`;

                // Fetch insights + campaign statuses in parallel (removed catalog - unused)
                const campaignStatusUrl = `https://graph.facebook.com/v21.0/${accId}/campaigns?fields=id,effective_status&limit=500&access_token=${access_token}`;
                const [rows, campaignRows] = await Promise.all([
                    this.fetchAllPages(url),
                    this.fetchAllPages(campaignStatusUrl),
                ]);
                if (rows.length === 0) {
                    metaErrors.push(`${accId}: 0 ads`);
                }

                // Build campaign_id → effective_status map
                const statusMap: Record<string, string> = {};
                campaignRows.forEach((c: any) => { statusMap[c.id] = c.effective_status || 'UNKNOWN'; });

                rows.forEach((row: any) => {
                    const actions = row.actions || [];
                    const actionValues = row.action_values || [];
                    const costPerAction = row.cost_per_action_type || [];

                    // ── Extract action metrics ──
                    const getAction = (types: string[]): number => {
                        for (const t of types) {
                            const found = actions.find((a: any) => a.action_type === t);
                            if (found) return parseInt(found.value || "0");
                        }
                        return 0;
                    };

                    const getActionValue = (types: string[]): number => {
                        for (const t of types) {
                            const found = actionValues.find((a: any) => a.action_type === t);
                            if (found) return parseFloat(found.value || "0");
                        }
                        return 0;
                    };

                    // Messages (first reply or conversation started)
                    const messages = getAction([
                        "onsite_conversion.messaging_first_reply",
                        "onsite_conversion.messaging_conversation_started_7d"
                    ]);

                    // Purchases (offsite conversions)
                    const purchases = getAction([
                        "offsite_conversion.fb_pixel_purchase",
                        "purchase",
                        "omni_purchase"
                    ]);

                    // Conversion value (revenue from purchases)
                    const conversionValue = getActionValue([
                        "offsite_conversion.fb_pixel_purchase",
                        "purchase",
                        "omni_purchase"
                    ]);

                    // Comments on post
                    const comments = getAction([
                        "comment",
                        "post_comment"
                    ]);

                    // Spend is already in VND (all accounts are VND)
                    const spend = parseFloat(row.spend || "0");
                    const impressions = parseInt(row.impressions || "0");
                    const reach = parseInt(row.reach || "0");

                    // CPM = (spend / impressions) * 1000
                    const cpm = impressions > 0 ? (spend / impressions) * 1000 : 0;

                    // Frequency = impressions / reach
                    const frequency = reach > 0 ? impressions / reach : 0;

                    // Cost per purchase
                    const costPerPurchase = purchases > 0 ? spend / purchases : 0;

                    // Cost per message
                    const costPerMessage = messages > 0 ? spend / messages : 0;

                    // ROAS = conversion_value / spend
                    const roas = spend > 0 ? conversionValue / spend : 0;

                    allAds.push({
                        account_id: accId,
                        campaign_id: row.campaign_id,
                        campaign_name: row.campaign_name,
                        ad_id: row.ad_id,
                        adset_name: row.adset_name || "",
                        effective_status: statusMap[row.campaign_id] || "UNKNOWN",
                        // Raw metrics from Meta
                        spend,           // Already VND
                        impressions,
                        reach,
                        messages,
                        purchases,
                        conversion_value: conversionValue,
                        comments,
                        // Calculated metrics
                        cpm,
                        frequency: parseFloat(frequency.toFixed(2)),
                        cost_per_purchase: costPerPurchase,
                        cost_per_message: costPerMessage,
                        roas: parseFloat(roas.toFixed(2)),
                        // Legacy fields (for POS matching — will be updated later)
                        orders: 0,
                        revenue_vnd: 0
                    });
                });
            } catch (e: any) {
                const msg = `${accId}: ${e?.message || e}`;
                console.error(`Meta Ads Error: ${msg}`);
                metaErrors.push(msg);
            }
        }));
        return { ads: allAds, errors: metaErrors };
    }

    static async fetchPOSHybrid(fromDate: string, toDate: string): Promise<TAlphaOrder[]> {
        const cfg = this.loadConfig();

        // ═══ FETCH ALL 8 SHOPS IN PARALLEL (saves ~10s) ═══
        const shopResults = await Promise.all(cfg.poscake.shops.map(async (shop) => {
            const shopOrders: TAlphaOrder[] = [];
            try {
                const currency =
                    shop.name === "UAE" ? "AED" :
                    shop.name === "Saudi" ? "SAR" :
                    shop.name === "Kuwait" ? "KWD" :
                    shop.name === "Oman" ? "OMR" :
                    shop.name === "Qatar" ? "QAR" :
                    shop.name === "Bahrain" ? "BHD" :
                    shop.name === "Japan" ? "JPY" :
                    shop.name === "Taiwan" ? "TWD" : "AED";
                const rate = this.getExchangeRate(currency);
                const isZeroDecimal = currency === "JPY";

                let currentPage = 1;
                let totalPages = 1;
                let reachedPastOrders = false;

                while (currentPage <= totalPages && !reachedPastOrders) {
                    const url = `${shop.api_url}/shops/${shop.shop_id}/orders?api_key=${shop.api_key}&page_number=${currentPage}`;
                    const controller = new AbortController();
                    const timeout = setTimeout(() => controller.abort(), 10000);
                    const res = await fetch(url, { signal: controller.signal });
                    clearTimeout(timeout);
                    const data = await res.json();
                    totalPages = data.total_pages || 1;

                    const pageOrders = data.data || [];
                    if (pageOrders.length === 0) break;

                    for (const o of pageOrders) {
                        const rawInserted = String(o.inserted_at || '');
                        if (!rawInserted) continue;
                        const utcMs = new Date(rawInserted + 'Z').getTime();
                        const vnMs = utcMs + 7 * 60 * 60 * 1000;
                        const vn = new Date(vnMs);
                        const orderDate = `${vn.getUTCFullYear()}-${String(vn.getUTCMonth() + 1).padStart(2, '0')}-${String(vn.getUTCDate()).padStart(2, '0')}`;

                        if (orderDate < fromDate) { reachedPastOrders = true; break; }

                        if (orderDate >= fromDate && orderDate <= toDate) {
                            const rawCod = o.cod || o.total_price || 0;
                            const priceLocal = isZeroDecimal ? rawCod : rawCod / 100;
                            shopOrders.push({
                                id: String(o.id),
                                shop_name: shop.name,
                                ad_id: o.ad_id,
                                marketer: o.marketer?.name || o.marketer || "N/A",
                                total_price_local: priceLocal,
                                total_price_vnd: priceLocal * rate,
                                status: o.status,
                                inserted_at: o.inserted_at,
                                customer_name: o.shipping_address?.full_name || o.customer_name?.name || o.customer_name || "N/A"
                            });
                        }
                    }
                    currentPage++;
                    if (currentPage > 200) break;
                }
            } catch (e) {
                console.error(`POS Error (${shop.name}):`, e);
            }
            return shopOrders;
        }));

        return shopResults.flat();
    }

    // Map campaign name prefix to POS shop name
    private static MARKET_MAP: Record<string, string> = {
        "JAPAN": "Japan", "TAIWAN": "Taiwan",
        "SAUDI": "Saudi", "UAE": "UAE", "KUWAIT": "Kuwait",
        "OMAN": "Oman", "QATAR": "Qatar", "BAHRAIN": "Bahrain",
    };

    private static getCampaignMarket(campaignName: string): string | null {
        const prefix = (campaignName || "").split("/")[0]?.toUpperCase().trim();
        return this.MARKET_MAP[prefix] || null;
    }

    // Normalize tên để so sánh: bỏ dấu, lowercase, bỏ khoảng trắng thừa
    private static normalizeName(name: string): string {
        return (name || '')
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/đ/gi, 'd')
            .toLowerCase().trim();
    }

    static aggregate(ads: any[], orders: TAlphaOrder[]) {
        // Load marketer_map from config
        const cfg = this.loadConfig();
        const marketerMap: Record<string, string> = {};
        (cfg.marketer_map || []).forEach((m: any) => {
            marketerMap[this.normalizeName(m.pos_name)] = (m.campaign_key || '').toUpperCase();
        });

        // ═══ PASS 1: Match POS orders by ad_id (strict) ═══
        const adIdMap = new Map<string, number>();
        ads.forEach((ad, idx) => { if (ad.ad_id) adIdMap.set(String(ad.ad_id), idx); });

        const matchedOrderIds = new Set<string>();

        orders.forEach(order => {
            const adId = order.ad_id ? String(order.ad_id) : null;
            if (!adId) return;

            if (adIdMap.has(adId)) {
                const idx = adIdMap.get(adId)!;
                ads[idx].orders += 1;
                ads[idx].revenue_vnd += order.total_price_vnd;
                matchedOrderIds.add(order.id);
            }
        });

        // ═══ PASS 2: Match remaining orders by marketer name + market ═══
        // For orders without ad_id (e.g. Japan POS), match by:
        //   POS marketer name → campaign_key (from marketer_map)
        //   POS shop_name → campaign market prefix (from MARKET_MAP)
        const unmatchedOrders = orders.filter(o => !matchedOrderIds.has(o.id));
        if (unmatchedOrders.length > 0) {
            // Build campaign index: market/campaignKey → list of ad indices
            const campaignIndex = new Map<string, number[]>();
            ads.forEach((ad, idx) => {
                const info = this.parseCampaign(ad.campaign_name);
                const market = info.country; // e.g. "JAPAN"
                const mktKey = this.removeDiacritics(info.marketerDisplay.toUpperCase()).trim();
                if (market && mktKey) {
                    const key = `${market}/${mktKey}`;
                    if (!campaignIndex.has(key)) campaignIndex.set(key, []);
                    campaignIndex.get(key)!.push(idx);
                }
            });

            // Reverse MARKET_MAP: "Japan" → "JAPAN"
            const shopToMarket: Record<string, string> = {};
            Object.entries(this.MARKET_MAP).forEach(([k, v]) => { shopToMarket[v] = k; });

            unmatchedOrders.forEach(order => {
                const posMarketer = this.normalizeName(typeof order.marketer === 'string' ? order.marketer : '');
                const campaignKey = marketerMap[posMarketer];
                if (!campaignKey) return;

                const market = shopToMarket[order.shop_name] || '';
                if (!market) return;

                const lookupKey = `${market}/${campaignKey}`;
                const indices = campaignIndex.get(lookupKey);
                if (indices && indices.length > 0) {
                    // Distribute to the campaign with highest spend
                    const bestIdx = indices.reduce((best, idx) =>
                        ads[idx].spend > ads[best].spend ? idx : best, indices[0]);
                    ads[bestIdx].orders += 1;
                    ads[bestIdx].revenue_vnd += order.total_price_vnd;
                    matchedOrderIds.add(order.id);
                }
            });
        }

        // Log remaining unmatched
        const finalUnmatched = orders.filter(o => !matchedOrderIds.has(o.id));
        if (finalUnmatched.length > 0) {
            const unmatchedRevenue = finalUnmatched.reduce((s, o) => s + o.total_price_vnd, 0);
            console.log(`[POS] ${finalUnmatched.length} orders unmatched — revenue: ${unmatchedRevenue.toLocaleString()}đ`);
        }

        // ═══ Aggregate totals ═══
        const totalSpend = ads.reduce((s, a) => s + a.spend, 0);
        const totalImpressions = ads.reduce((s, a) => s + a.impressions, 0);
        const totalReach = ads.reduce((s, a) => s + a.reach, 0);
        const totalMessages = ads.reduce((s, a) => s + a.messages, 0);
        const totalPurchases = ads.reduce((s, a) => s + a.purchases, 0);
        const totalConversionValue = ads.reduce((s, a) => s + a.conversion_value, 0);
        const totalComments = ads.reduce((s, a) => s + a.comments, 0);

        // POS totals
        const posOrders = orders.length;
        const posRevenue = orders.reduce((s, o) => s + o.total_price_vnd, 0);
        const posRoas = totalSpend > 0 ? posRevenue / totalSpend : 0;

        return {
            ads,
            orders,
            total_spend: totalSpend,
            total_impressions: totalImpressions,
            total_reach: totalReach,
            total_messages: totalMessages,
            total_purchases: totalPurchases,
            total_conversion_value: totalConversionValue,
            total_comments: totalComments,
            total_cpm: totalImpressions > 0 ? (totalSpend / totalImpressions) * 1000 : 0,
            total_frequency: totalReach > 0 ? totalImpressions / totalReach : 0,
            total_roas: totalSpend > 0 ? totalConversionValue / totalSpend : 0,
            total_cost_per_purchase: totalPurchases > 0 ? totalSpend / totalPurchases : 0,
            total_cost_per_message: totalMessages > 0 ? totalSpend / totalMessages : 0,
            pos_orders: posOrders,
            pos_revenue: posRevenue,
            pos_roas: parseFloat(posRoas.toFixed(2)),
        };
    }

    static removeDiacritics(str: string) {
        return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd');
    }

    static parseCampaign(campaignName: string) {
        const parts = (campaignName || "").split("/").map(s => s.trim());
        const lastPart = parts[parts.length - 1]?.toUpperCase();
        return {
            country: (parts[0] || "").toUpperCase(),
            marketer: this.removeDiacritics((parts[1] || "").toUpperCase()),
            marketerDisplay: parts[1] || "",
            product: parts[2] || "",
            pageId: parts[3] || "",
            pageName: parts[4] || "",
            isTest: lastPart === "TEST",
        };
    }

    static aggregateByMktMarket(ads: any[], orders: any[]) {
        const map: Record<string, {
            marketer: string;
            market: string;
            spend: number;
            messages: number;
            purchases: number;
            conversion_value: number;
            pos_orders: number;
            pos_revenue: number;
        }> = {};

        // 1. Group by Ads
        ads.forEach(ad => {
            const info = this.parseCampaign(ad.campaign_name);
            const mkt = info.marketerDisplay || 'N/A';
            const market = info.country || 'N/A';
            const key = `${this.removeDiacritics(mkt.toUpperCase())}__${market}`;

            if (!map[key]) {
                map[key] = { marketer: mkt, market, spend: 0, messages: 0, purchases: 0, conversion_value: 0, pos_orders: 0, pos_revenue: 0 };
            }
            const r = map[key];
            r.spend += ad.spend || 0;
            r.messages += ad.messages || 0;
            r.purchases += ad.purchases || 0;
            r.conversion_value += ad.conversion_value || 0;
            
            // Note: ad.orders and ad.revenue_vnd are already mapped per-ad in TAlphaAdsModel.fetchMetaAds
            r.pos_orders += ad.orders || 0;
            r.pos_revenue += ad.revenue_vnd || 0;
        });

        return Object.values(map).sort((a, b) => b.spend - a.spend);
    }
}
