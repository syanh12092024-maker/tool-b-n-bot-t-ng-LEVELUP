import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import yaml from "js-yaml";

// ─── Types ────────────────────────────────────────────────────────────────────
interface ShopConfig {
    name: string;
    api_key: string;
    shop_id: string;
}

interface FacebookConfig {
    access_token: string;
    app_id?: string;
    app_secret?: string;
}

interface ScriptGeneratorConfig {
    poscake: {
        api_url: string;
        shops: ShopConfig[];
    };
    pancake_crm?: {
        api_url: string;
        api_token: string;
    };
    meta_ads?: {
        access_token: string;
        app_id?: string;
        app_secret?: string;
    };
    facebook_messaging?: {
        app_id: string;
        user_access_token: string;
        app_secret?: string;
        page_tokens?: Record<string, string>; // pageId → access_token (trực tiếp từ config)
    };
}

interface PancakeCustomer {
    id: string;
    name: string;
    fb_id: string;
    customer_id: string;
    phone_numbers?: string[];
    conversation_link: string;
    order_count: number;
    updated_at: string;
    inserted_at: string;
    tags?: Array<{ name: string }>;
    shop_customer_addresses?: Array<{ full_address?: string }>;
}

interface CRMConversation {
    id: string;
    from: { id: string; name: string };
    from_psid: number | string;
    snippet: string;
    message_count: number;
    tags: number[];
    has_phone: boolean;
    recent_phone_numbers: Array<string | { phone_number?: string; captured?: string }>;
    updated_at: string;
    inserted_at: string;
    last_message_at?: string;
    last_customer_interactive_at: string;
    customers: Array<{ fb_id: string; id: string; name: string }>;
    page_id: number | string;
    type: string;
}

// ─── Load config ──────────────────────────────────────────────────────────────
function loadConfig(): ScriptGeneratorConfig {
    // Load script-generator.yaml (primary)
    const configPath = path.join(process.cwd(), "config", "script-generator.yaml");
    const raw = fs.readFileSync(configPath, "utf-8");
    const config = yaml.load(raw) as ScriptGeneratorConfig;
    
    // Load talpha.yaml for Facebook credentials
    try {
        const talphaPath = path.join(process.cwd(), "config", "projects", "talpha.yaml");
        const talphaRaw = fs.readFileSync(talphaPath, "utf-8");
        const talphaConfig = yaml.load(talphaRaw) as Record<string, unknown>;
        if (talphaConfig?.meta_ads) {
            config.meta_ads = talphaConfig.meta_ads as ScriptGeneratorConfig['meta_ads'];
        }
    } catch { /* ignore if talpha.yaml not found */ }
    
    return config;
}

// ─── GET: Lấy conversations (CRM) hoặc customers (POS fallback) ─────────────
export async function GET(req: NextRequest) {
    try {
        const config = loadConfig();
        const { searchParams } = new URL(req.url);
        const shopId = searchParams.get("shopId");
        const getPages = searchParams.get("getPages") === "true";
        const pageFilter = searchParams.get("pageFilter") || "";
        const page = searchParams.get("page") || "1";
        const debugCrm = searchParams.get("debugCrm") === "true";

        // ═══ DEBUG CRM: Comprehensive Pancake API param testing ═══
        if (debugCrm && pageFilter && config.pancake_crm?.api_token) {
            const apiUrl = config.pancake_crm.api_url;
            const token = config.pancake_crm.api_token;
            const results: Array<Record<string, unknown>> = [];
            const mask = (u: string) => u.replace(token, '***');

            // --- Test 1: Default fetch (baseline) ---
            const url1 = `${apiUrl}/pages/${pageFilter}/conversations?access_token=${token}&limit=500`;
            const r1 = await fetch(url1);
            const d1 = await r1.json();
            const c1: CRMConversation[] = d1.conversations || [];
            const allIds1 = new Set(c1.map(c => c.id));
            results.push({
                test: "1: baseline limit=500",
                url: mask(url1),
                count: c1.length,
                firstId: c1[0]?.id,
                lastId: c1[c1.length - 1]?.id,
                responseKeys: Object.keys(d1),
                sampleFields: c1[0] ? Object.keys(c1[0]) : [],
            });

            // --- Test 2: Cursor pagination with last_conversation_id ---
            if (c1.length > 0) {
                const lastId = c1[c1.length - 1].id;
                const url2 = `${apiUrl}/pages/${pageFilter}/conversations?access_token=${token}&limit=500&last_conversation_id=${lastId}`;
                const r2 = await fetch(url2);
                const d2 = await r2.json();
                const c2: CRMConversation[] = d2.conversations || [];
                const overlap = c2.filter(c => allIds1.has(c.id)).length;
                const newUnique = c2.length - overlap;
                results.push({
                    test: `2: cursor last_conversation_id=${lastId}`,
                    url: mask(url2),
                    count: c2.length,
                    overlap,
                    newUnique,
                    cursorWorks: newUnique > 0,
                });
            }

            // --- Test 3: Fetch conversation tags → test per-tag filtering ---
            let tagList: Array<{id: number; name: string}> = [];
            try {
                const tagUrl = `${apiUrl}/pages/${pageFilter}/conversation_tags?access_token=${token}`;
                const tagRes = await fetch(tagUrl);
                const tagData = await tagRes.json();
                tagList = (tagData.conversation_tags || []).map((t: {id: number; name: string}) => ({
                    id: Number(t.id),
                    name: String(t.name || ''),
                }));
                results.push({
                    test: "3: available tags",
                    totalTags: tagList.length,
                    tags: tagList.map(t => `[${t.id}] ${t.name}`),
                });
            } catch (err) {
                results.push({ test: "3: tags fetch failed", error: String(err) });
            }

            // --- Test 4: Filter by tag_id (test first 3 tags) ---
            for (const tag of tagList.slice(0, 3)) {
                const urlTag = `${apiUrl}/pages/${pageFilter}/conversations?access_token=${token}&limit=500&tag_id=${tag.id}`;
                try {
                    const rTag = await fetch(urlTag);
                    const dTag = await rTag.json();
                    const cTag: CRMConversation[] = dTag.conversations || [];
                    const newFromTag = cTag.filter(c => !allIds1.has(c.id)).length;
                    results.push({
                        test: `4: tag_id=${tag.id} (${tag.name})`,
                        url: mask(urlTag),
                        count: cTag.length,
                        newVsBaseline: newFromTag,
                        tagFilterWorks: !dTag.error_code,
                    });
                } catch (err) {
                    results.push({ test: `4: tag_id=${tag.id} failed`, error: String(err) });
                }
            }

            // --- Test 5: Filter by type (inbox vs comment vs ...) ---
            for (const type of ["inbox", "comment", "livechat"]) {
                const urlType = `${apiUrl}/pages/${pageFilter}/conversations?access_token=${token}&limit=500&type=${type}`;
                try {
                    const rType = await fetch(urlType);
                    const dType = await rType.json();
                    const cType: CRMConversation[] = dType.conversations || [];
                    const newFromType = cType.filter(c => !allIds1.has(c.id)).length;
                    results.push({
                        test: `5: type=${type}`,
                        url: mask(urlType),
                        count: cType.length,
                        newVsBaseline: newFromType,
                        typeFilterWorks: !dType.error_code,
                    });
                } catch (err) {
                    results.push({ test: `5: type=${type} failed`, error: String(err) });
                }
            }

            // --- Test 6: Filter by is_read status ---
            for (const isRead of ["true", "false"]) {
                const urlRead = `${apiUrl}/pages/${pageFilter}/conversations?access_token=${token}&limit=500&is_read=${isRead}`;
                try {
                    const rRead = await fetch(urlRead);
                    const dRead = await rRead.json();
                    const cRead: CRMConversation[] = dRead.conversations || [];
                    results.push({
                        test: `6: is_read=${isRead}`,
                        url: mask(urlRead),
                        count: cRead.length,
                        filterWorks: !dRead.error_code,
                    });
                } catch (err) {
                    results.push({ test: `6: is_read=${isRead} failed`, error: String(err) });
                }
            }

            // --- Test 7: Search param ---
            const urlSearch = `${apiUrl}/pages/${pageFilter}/conversations?access_token=${token}&limit=500&search=a`;
            try {
                const rSearch = await fetch(urlSearch);
                const dSearch = await rSearch.json();
                const cSearch: CRMConversation[] = dSearch.conversations || [];
                results.push({
                    test: "7: search=a",
                    url: mask(urlSearch),
                    count: cSearch.length,
                    searchWorks: !dSearch.error_code,
                });
            } catch (err) {
                results.push({ test: "7: search failed", error: String(err) });
            }

            // --- Test 8: Sort order (oldest first) ---
            const urlSort = `${apiUrl}/pages/${pageFilter}/conversations?access_token=${token}&limit=500&sort=asc`;
            try {
                const rSort = await fetch(urlSort);
                const dSort = await rSort.json();
                const cSort: CRMConversation[] = dSort.conversations || [];
                const newFromSort = cSort.filter(c => !allIds1.has(c.id)).length;
                results.push({
                    test: "8: sort=asc (oldest first)",
                    url: mask(urlSort),
                    count: cSort.length,
                    newVsBaseline: newFromSort,
                    sortWorks: cSort.length > 0 && !dSort.error_code,
                });
            } catch (err) {
                results.push({ test: "8: sort=asc failed", error: String(err) });
            }

            // --- POS: Count how many POS customers exist for comparison ---
            let posCount = 0;
            try {
                const shop = config.poscake.shops[0];
                if (shop) {
                    const posUrl = `${config.poscake.api_url}/shops/${shop.shop_id}/customers?api_key=${shop.api_key}&page=1&page_size=1`;
                    const posRes = await fetch(posUrl);
                    const posData = await posRes.json();
                    posCount = posData.total_count || posData.total || (posData.data || []).length;
                }
            } catch { /* ignore */ }

            results.push({
                test: "9: POS total customers (for reference)",
                posCustomerCount: posCount,
            });

            return NextResponse.json({
                debugCrm: true,
                pageId: pageFilter,
                crmBaseline: c1.length,
                results,
                recommendation: c1.length >= 500
                    ? "CRM is at 500 cap. Check which filters return newVsBaseline > 0 to find strategies for fetching beyond 500."
                    : `CRM returned ${c1.length} (under 500 cap). All data may already be fetched.`,
            });
        }

        if (!shopId) {
            // ─── getPages=true without shopId → fetch pages from ALL sources ───
            // Merge 3 nguồn: POS + Pancake CRM + Facebook Graph API
            if (getPages) {
                try {
                    const allPages: Array<{ pageId: string; name: string; platform: string; shopName: string; source: string }> = [];
                    const seenPageIds = new Set<string>();

                    const addPage = (pid: string, name: string, platform: string, shopName: string, source: string) => {
                        if (!seenPageIds.has(pid)) {
                            seenPageIds.add(pid);
                            allPages.push({ pageId: pid, name: name || `Page ${pid}`, platform, shopName, source });
                        }
                    };

                    // ═══ SOURCE 1: POS (Pancake POS shops) ═══
                    await Promise.all(config.poscake.shops.map(async (s) => {
                        try {
                            const shopRes = await fetch(
                                `${config.poscake.api_url}/shops/${s.shop_id}?api_key=${s.api_key}`
                            );
                            const shopData = await shopRes.json();
                            const shopInfo = shopData?.shop || shopData;
                            for (const p of (shopInfo?.pages || [])) {
                                addPage(String(p.id), p.name, p.platform || "facebook", s.name, "pos");
                            }
                        } catch (err) {
                            console.error(`[broadcast] POS pages for shop ${s.name} error:`, err);
                        }
                    }));

                    // ═══ SOURCE 2: Pancake CRM (pages accessible via CRM token) ═══
                    if (config.pancake_crm?.api_token) {
                        try {
                            const crmPagesUrl = `${config.pancake_crm.api_url}/me?access_token=${config.pancake_crm.api_token}`;
                            const crmRes = await fetch(crmPagesUrl);
                            const contentType = crmRes.headers.get('content-type') || '';
                            if (contentType.includes('application/json') && crmRes.ok) {
                                const crmData = await crmRes.json();
                                // Pancake /me returns user info with pages list
                                const crmPages = crmData?.pages || crmData?.data?.pages || [];
                                for (const p of crmPages) {
                                    const pid = String(p.id || p.page_id || "");
                                    if (pid) {
                                        addPage(pid, p.name || p.page_name || "", "facebook", "CRM", "crm");
                                    }
                                }
                                console.log(`[broadcast] CRM /me pages: found ${crmPages.length} pages`);
                            } else {
                                console.warn(`[broadcast] CRM /me returned non-JSON (${crmRes.status}), skipping`);
                            }
                        } catch (err) {
                            console.error("[broadcast] CRM pages fetch error:", err);
                        }

                        // Also try fetching page list from each shop via CRM
                        try {
                            const shopsUrl = `${config.pancake_crm.api_url}/shops?access_token=${config.pancake_crm.api_token}`;
                            const shopsRes = await fetch(shopsUrl);
                            const shopsCt = shopsRes.headers.get('content-type') || '';
                            if (shopsCt.includes('application/json') && shopsRes.ok) {
                                const shopsData = await shopsRes.json();
                                const crmShops = shopsData?.shops || shopsData?.data || [];
                                for (const shop of crmShops) {
                                    const shopPages = shop.pages || [];
                                    for (const p of shopPages) {
                                        const pid = String(p.id || p.page_id || "");
                                        if (pid) {
                                            addPage(pid, p.name || p.page_name || "", "facebook", shop.name || "CRM", "crm");
                                        }
                                    }
                                }
                                console.log(`[broadcast] CRM shops: found ${crmShops.length} shops`);
                            } else {
                                console.warn(`[broadcast] CRM /shops returned non-JSON (${shopsRes.status}), skipping`);
                            }
                        } catch (err) {
                            console.error("[broadcast] CRM shops fetch error:", err);
                        }
                    }

                    // ═══ SOURCE 3: Facebook Graph API (/me/accounts) ═══
                    const fbUserToken = config.meta_ads?.access_token || config.facebook_messaging?.user_access_token;
                    if (fbUserToken) {
                        try {
                            let fbUrl = `https://graph.facebook.com/v21.0/me/accounts?access_token=${fbUserToken}&limit=100&fields=id,name,access_token`;
                            let fbPageCount = 0;
                            while (fbUrl) {
                                const fbRes = await fetch(fbUrl);
                                const fbData = await fbRes.json();
                                if (fbData.error) {
                                    console.error("[broadcast] FB Graph pages error:", fbData.error.message);
                                    break;
                                }
                                for (const p of (fbData.data || [])) {
                                    addPage(String(p.id), p.name || "", "facebook", "Facebook", "fb_graph");
                                    fbPageCount++;
                                }
                                fbUrl = fbData.paging?.next || "";
                            }
                            console.log(`[broadcast] FB Graph pages: found ${fbPageCount} pages`);
                        } catch (err) {
                            console.error("[broadcast] FB Graph pages fetch error:", err);
                        }
                    }

                    console.log(`[broadcast] Total merged pages: ${allPages.length} (POS: ${allPages.filter(p => p.source === 'pos').length}, CRM: ${allPages.filter(p => p.source === 'crm').length}, FB: ${allPages.filter(p => p.source === 'fb_graph').length})`);
                    allPages.sort((a, b) => a.name.localeCompare(b.name));
                    return NextResponse.json({ pages: allPages, shopName: "Tất cả", totalPages: allPages.length });
                } catch (err) {
                    console.error("[broadcast] All pages fetch error:", err);
                    return NextResponse.json({ pages: [], shopName: "Tất cả" });
                }
            }

            // ─── No shopId, but have pageFilter → CRM first, POS fallback ───
            if (pageFilter) {
                let crmData: object | null = null;
                let crmErr: string | null = null;

                // Try CRM first
                if (config.pancake_crm?.api_token) {
                    try {
                        crmData = await fetchCRMConversations(
                            config.pancake_crm.api_url,
                            config.pancake_crm.api_token,
                            pageFilter,
                            Number(page)
                        );
                        if (crmData) return NextResponse.json(crmData);
                        crmErr = `CRM không trả data cho page ${pageFilter}.`;
                    } catch (err) {
                        console.error("[broadcast] CRM-only error:", err);
                        crmErr = `CRM lỗi: ${err instanceof Error ? err.message : String(err)}`;
                    }
                }

                // ═══ POS FALLBACK 1: tìm shop chứa page này → lấy khách từ POS ═══
                console.log(`[broadcast] CRM failed/skipped, trying POS fallback for page ${pageFilter}`);
                for (const shop of config.poscake.shops) {
                    try {
                        const shopRes = await fetch(
                            `${config.poscake.api_url}/shops/${shop.shop_id}?api_key=${shop.api_key}`
                        );
                        const shopData = await shopRes.json();
                        const shopInfo = shopData?.shop || shopData;
                        const pageIds = (shopInfo?.pages || []).map((p: { id: string }) => String(p.id));
                        if (pageIds.includes(pageFilter)) {
                            console.log(`[broadcast] Found page ${pageFilter} in shop ${shop.name}, fetching POS customers`);
                            const posResponse = await fetchPOSCustomers(config, shop, page, pageFilter);
                            const posData = await posResponse.json();
                            if ((posData.customers || []).length > 0) {
                                return NextResponse.json({
                                    ...posData,
                                    crmWarning: crmErr ? `⚠️ ${crmErr} Đang hiển thị khách từ POS (${shop.name}).` : undefined,
                                });
                            }
                        }
                    } catch (e) {
                        console.error(`[broadcast] POS fallback shop ${shop.name} error:`, e);
                    }
                }

                // ═══ POS FALLBACK 2: page không thuộc shop nào → lấy ALL customers từ ALL shops ═══
                console.log(`[broadcast] Page ${pageFilter} not found in any shop, trying ALL shops fallback`);
                const allPosCustomers: Array<Record<string, unknown>> = [];
                const seenPosIds = new Set<string>();
                for (const shop of config.poscake.shops) {
                    try {
                        const posResponse = await fetchPOSCustomers(config, shop, page, "");
                        const posData = await posResponse.json();
                        for (const c of (posData.customers || [])) {
                            const cId = String(c.id || '');
                            if (cId && !seenPosIds.has(cId)) {
                                seenPosIds.add(cId);
                                allPosCustomers.push(c);
                            }
                        }
                    } catch { /* ignore */ }
                }

                if (allPosCustomers.length > 0) {
                    console.log(`[broadcast] ALL shops fallback: loaded ${allPosCustomers.length} total POS customers`);
                    return NextResponse.json({
                        customers: allPosCustomers,
                        total: allPosCustomers.length,
                        page: 1,
                        totalPages: 1,
                        source: "pos",
                        crmWarning: crmErr ? `⚠️ ${crmErr} Đang hiển thị khách từ tất cả shops (POS).` : undefined,
                    });
                }

                return NextResponse.json({
                    customers: [], total: 0, page: 1, totalPages: 1,
                    crmWarning: `⚠️ ${crmErr || 'Không tìm thấy data.'} Không tìm được khách hàng nào.`,
                });
            }

            const shops = config.poscake.shops.map((s) => ({
                name: s.name,
                shop_id: s.shop_id,
            }));
            return NextResponse.json({ shops });
        }

        const shop = config.poscake.shops.find((s) => s.shop_id === shopId);
        if (!shop) {
            return NextResponse.json({ error: `Shop ${shopId} không tồn tại` }, { status: 404 });
        }

        // If getPages=true, return list of pages for this shop
        if (getPages) {
            try {
                const shopRes = await fetch(
                    `${config.poscake.api_url}/shops/${shop.shop_id}?api_key=${shop.api_key}`
                );
                const shopData = await shopRes.json();
                const shopInfo = shopData?.shop || shopData;

                const pages = (shopInfo?.pages || []).map((p: { id: string; name?: string; platform?: string }) => ({
                    pageId: String(p.id),
                    name: p.name || `Page ${p.id}`,
                    platform: p.platform || "facebook",
                }));

                pages.sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name));

                return NextResponse.json({ pages, shopName: shop.name, totalPages: pages.length });
            } catch (err) {
                console.error("[broadcast] Pages fetch error:", err);
                return NextResponse.json({ pages: [], shopName: shop.name });
            }
        }

        // ─── Primary: CRM Conversations (ALL who messaged) ────────────────
        // ─── Enhanced: CRM + POS merge for maximum coverage ──────────────
        let crmError: string | null = null;
        let crmResult: Record<string, unknown> | null = null;

        if (pageFilter && config.pancake_crm?.api_token) {
            try {
                crmResult = await fetchCRMConversations(
                    config.pancake_crm.api_url,
                    config.pancake_crm.api_token,
                    pageFilter,
                    Number(page)
                ) as Record<string, unknown> | null;
                if (!crmResult) {
                    crmError = `CRM không trả data cho page ${pageFilter}. Có thể cần đăng nhập lại Pancake.`;
                }
            } catch (err) {
                console.error("[broadcast] CRM error:", err);
                crmError = `CRM lỗi: ${err instanceof Error ? err.message : String(err)}`;
            }
        }

        // ─── Merge CRM + POS: bổ sung POS customers mà CRM không có ─────
        if (crmResult) {
            const crmCustomers = (crmResult.customers || []) as Array<Record<string, unknown>>;
            const crmPsids = new Set(crmCustomers.map(c => String(c.psid || '')).filter(Boolean));
            const crmPhones = new Set(crmCustomers.map(c => String(c.customerPhone || '')).filter(p => p && p !== 'has_phone'));
            const crmNames = new Set(crmCustomers.map(c => String(c.customerName || '').toLowerCase()).filter(Boolean));

            // Fetch POS data to supplement
            let posExtra: Array<Record<string, unknown>> = [];
            try {
                const posResponse = await fetchPOSCustomers(config, shop, page, pageFilter);
                const posData = await posResponse.json();
                const posCustomers = (posData.customers || []) as Array<Record<string, unknown>>;

                // Enrich CRM customers with POS data (orderCount, address)
                for (const crm of crmCustomers) {
                    const crmPhone = String(crm.customerPhone || '');
                    const crmName = String(crm.customerName || '').toLowerCase();
                    const matchedPos = posCustomers.find(pos => {
                        const posPhone = String(pos.customerPhone || '');
                        const posName = String(pos.customerName || '').toLowerCase();
                        // Match by phone or by exact name
                        if (crmPhone && posPhone && crmPhone === posPhone) return true;
                        if (crmName && posName && crmName === posName) return true;
                        return false;
                    });
                    if (matchedPos) {
                        crm.orderCount = Number(matchedPos.orderCount) || crm.orderCount;
                        if (!crm.customerPhone && matchedPos.customerPhone) {
                            crm.customerPhone = matchedPos.customerPhone;
                        }
                        if (!crm.address && matchedPos.address) {
                            crm.address = matchedPos.address;
                        }
                    }
                }

                // Add POS-only customers (those NOT in CRM)
                for (const pos of posCustomers) {
                    const posPhone = String(pos.customerPhone || '');
                    const posPsid = String(pos.psid || '');
                    const posName = String(pos.customerName || '').toLowerCase();

                    const alreadyInCrm =
                        (posPsid && crmPsids.has(posPsid)) ||
                        (posPhone && crmPhones.has(posPhone)) ||
                        (posName && crmNames.has(posName));

                    if (!alreadyInCrm && posPsid) {
                        posExtra.push({ ...pos, source: "pos" });
                    }
                }

                console.log(`[broadcast] CRM+POS merge: ${crmCustomers.length} CRM + ${posExtra.length} POS-only = ${crmCustomers.length + posExtra.length} total`);
            } catch (err) {
                console.error("[broadcast] POS supplement fetch failed (non-critical):", err);
            }

            const mergedCustomers = [...crmCustomers, ...posExtra];
            return NextResponse.json({
                ...crmResult,
                customers: mergedCustomers,
                total: mergedCustomers.length,
                debug: {
                    ...(crmResult.debug as Record<string, unknown> || {}),
                    posExtra: posExtra.length,
                    mergedTotal: mergedCustomers.length,
                    crmOnly: crmCustomers.length,
                },
            });
        }

        // ─── Fallback: POS Customers only (CRM failed) ───────────────────
        const posResponse = await fetchPOSCustomers(config, shop, page, pageFilter);
        if (crmError) {
            const posData = await posResponse.json();
            return NextResponse.json({
                ...posData,
                crmWarning: `⚠️ ${crmError} — Chỉ hiển thị khách ĐÃ MUA từ POS. Để lấy TẤT CẢ khách nhắn tin, đăng nhập lại Pancake CRM.`,
            });
        }
        return posResponse;
    } catch (error: unknown) {
        console.error("[broadcast] GET Error:", error);
        const message = error instanceof Error ? error.message : "Unknown error";
        return NextResponse.json({ error: message }, { status: 500 });
    }
}

// ─── CRM Conversations fetcher ───────────────────────────────────────────────
// ═══ Multi-strategy fetch: vượt giới hạn 500 bằng tag-based + cursor splitting ═══

async function fetchCRMBatch(
    apiUrl: string, token: string, pageId: string, extraParams: string = ""
): Promise<{ conversations: CRMConversation[]; error?: string }> {
    const url = `${apiUrl}/pages/${pageId}/conversations?access_token=${token}&limit=500${extraParams}`;
    try {
        const res = await fetch(url);
        const data = await res.json();
        if (data.error_code) return { conversations: [], error: `[${data.error_code}] ${data.message}` };
        return { conversations: data.conversations || [] };
    } catch (err) {
        return { conversations: [], error: String(err) };
    }
}

async function fetchCRMConversations(
    apiUrl: string,
    token: string,
    pageId: string,
    _page: number
): Promise<object | null> {
    const seenIds = new Set<string>();
    const allConversations: CRMConversation[] = [];
    const strategyLog: Array<{ strategy: string; fetched: number; new: number }> = [];

    const addBatch = (batch: CRMConversation[], strategy: string) => {
        let newCount = 0;
        for (const c of batch) {
            if (c.id && !seenIds.has(String(c.id))) {
                seenIds.add(String(c.id));
                allConversations.push(c);
                newCount++;
            }
        }
        strategyLog.push({ strategy, fetched: batch.length, new: newCount });
        console.log(`[broadcast] CRM [${strategy}]: fetched=${batch.length}, new=${newCount}, total=${allConversations.length}`);
        return newCount;
    };

    // ═══ STRATEGY 1: Default fetch (newest 500) ═══
    const batch1 = await fetchCRMBatch(apiUrl, token, pageId);
    if (batch1.error) {
        console.error(`[broadcast] CRM Error: ${batch1.error}`);
        return null;
    }
    addBatch(batch1.conversations, "default");

    // Only try additional strategies if we hit the 500 cap
    if (batch1.conversations.length >= 500) {
        // ═══ STRATEGY 2: Cursor pagination (last_conversation_id) ═══
        let cursor = batch1.conversations[batch1.conversations.length - 1]?.id;
        let cursorAttempts = 0;
        const maxCursorPages = 20; // Tăng từ 10 → 20
        while (cursor && cursorAttempts < maxCursorPages) {
            const cursorBatch = await fetchCRMBatch(apiUrl, token, pageId, `&last_conversation_id=${cursor}`);
            const newFromCursor = addBatch(cursorBatch.conversations, `cursor_page_${cursorAttempts + 1}`);
            if (newFromCursor === 0 || cursorBatch.conversations.length === 0) break;
            cursor = cursorBatch.conversations[cursorBatch.conversations.length - 1]?.id;
            cursorAttempts++;
        }

        // ═══ STRATEGY 3: Per-tag filtering ═══
        let tagList: Array<{ id: number; name: string }> = [];
        try {
            const tagUrl = `${apiUrl}/pages/${pageId}/conversation_tags?access_token=${token}`;
            const tagRes = await fetch(tagUrl);
            const tagData = await tagRes.json();
            tagList = (tagData.conversation_tags || []).map((t: { id: number; name: string }) => ({
                id: Number(t.id),
                name: String(t.name || ''),
            }));
        } catch { /* ignore */ }

        for (const tag of tagList) {
            const tagBatch = await fetchCRMBatch(apiUrl, token, pageId, `&tag_id=${tag.id}`);
            if (tagBatch.conversations.length > 0) {
                addBatch(tagBatch.conversations, `tag:${tag.name}`);
            }
        }

        // ═══ STRATEGY 4: Type-based filtering (inbox vs comment) ═══
        for (const type of ["inbox", "comment"]) {
            const typeBatch = await fetchCRMBatch(apiUrl, token, pageId, `&type=${type}`);
            if (typeBatch.conversations.length > 0) {
                addBatch(typeBatch.conversations, `type:${type}`);
            }
        }

        // ═══ STRATEGY 5: is_read filtering ═══
        for (const isRead of ["true", "false"]) {
            const readBatch = await fetchCRMBatch(apiUrl, token, pageId, `&is_read=${isRead}`);
            if (readBatch.conversations.length > 0) {
                addBatch(readBatch.conversations, `is_read:${isRead}`);
            }
        }

        // ═══ STRATEGY 6: Offset pagination (skip-based) ═══
        for (let offset = 500; offset <= 5000; offset += 500) {
            const offsetBatch = await fetchCRMBatch(apiUrl, token, pageId, `&offset=${offset}`);
            const newFromOffset = addBatch(offsetBatch.conversations, `offset:${offset}`);
            if (newFromOffset === 0 || offsetBatch.conversations.length === 0) break;
        }

        // ═══ STRATEGY 7: Time-based splitting (older conversations) ═══
        // Lấy timestamp cũ nhất trong batch hiện tại → fetch conversations cũ hơn
        const timestamps = allConversations
            .map(c => c.last_message_at || c.updated_at || '')
            .filter(t => t)
            .sort();
        if (timestamps.length > 0) {
            const oldestTime = timestamps[0];
            const oldestDate = new Date(oldestTime);
            // Try fetching conversations trước ngày cũ nhất
            const timeRanges = [30, 60, 90, 180, 365]; // days back
            for (const daysBack of timeRanges) {
                const beforeDate = new Date(oldestDate.getTime() - daysBack * 86400000);
                const beforeStr = beforeDate.toISOString().split('T')[0];
                const timeBatch = await fetchCRMBatch(apiUrl, token, pageId, `&before=${beforeStr}`);
                const newFromTime = addBatch(timeBatch.conversations, `before:${beforeStr}`);
                if (newFromTime === 0 || timeBatch.conversations.length === 0) break;
            }
        }

        // ═══ STRATEGY 8: Sort order variation ═══
        for (const sort of ["asc", "oldest"]) {
            const sortBatch = await fetchCRMBatch(apiUrl, token, pageId, `&sort=${sort}`);
            if (sortBatch.conversations.length > 0) {
                addBatch(sortBatch.conversations, `sort:${sort}`);
            }
        }
    }

    // ═══ FILTER: chỉ giữ conversations thuộc đúng page_id ═══
    const filteredConversations = allConversations.filter(c => {
        const cPageId = String(c.page_id || '');
        return cPageId === pageId;
    });

    console.log(`[broadcast] CRM after page_id filter: ${filteredConversations.length} (from ${allConversations.length} total merged)`);

    // ═══ RESOLVE TAG IDs → TAG NAMES ═══
    let tagMap: Map<number, string> = new Map();
    try {
        const tagUrl = `${apiUrl}/pages/${pageId}/conversation_tags?access_token=${token}`;
        const tagRes = await fetch(tagUrl);
        const tagData = await tagRes.json();
        if (tagData.conversation_tags) {
            for (const t of tagData.conversation_tags) {
                tagMap.set(Number(t.id), String(t.name || ''));
            }
            console.log(`[broadcast] CRM tags resolved: ${tagMap.size} tags for pageId=${pageId}`);
        }
    } catch (err) {
        console.error(`[broadcast] CRM tag resolution failed:`, err);
    }

    const allCustomers = filteredConversations
        .filter((c) => c && c.id && (c.from_psid || c.from?.id))
        .map((c) => {
            let phone = "";
            const phoneArr = c.recent_phone_numbers || [];
            if (phoneArr.length > 0) {
                const p = phoneArr[0];
                if (typeof p === 'string') {
                    phone = p;
                } else if (p && typeof p === 'object') {
                    phone = (p as Record<string, string>).phone_number || (p as Record<string, string>).captured || String(p);
                }
            }
            if (!phone && c.has_phone) {
                phone = "has_phone";
            }

            const resolvedTags = (c.tags || []).map((t: number) => {
                const name = tagMap.get(Number(t));
                return name || String(t);
            });

            return {
                id: String(c.id || ""),
                customerName: String(c.from?.name || c.customers?.[0]?.name || "Không rõ tên"),
                customerPhone: phone,
                fbId: String(c.id || ""),
                psid: String(c.from_psid || c.from?.id || ""),
                pageFbId: String(c.page_id || pageId),
                customerId: String(c.customers?.[0]?.id || ""),
                conversationLink: `https://pages.fm/conversations/${String(c.id || "")}`,
                orderCount: 0,
                messageCount: Number(c.message_count) || 0,
                snippet: String(c.snippet || "").replace(/[\r\n]+/g, " ").slice(0, 100),
                tags: resolvedTags,
                address: "",
                updatedAt: String(c.updated_at || c.inserted_at || ""),
                lastInteraction: String(c.last_customer_interactive_at || ""),
                source: "crm" as const,
            };
        });

    // Collect unique page_ids for debugging
    const uniquePageIds = new Map<string, number>();
    for (const c of allConversations) {
        const pid = String(c.page_id || 'unknown');
        uniquePageIds.set(pid, (uniquePageIds.get(pid) || 0) + 1);
    }

    return {
        customers: allCustomers,
        total: allCustomers.length,
        page: 1,
        totalPages: 1,
        source: "crm",
        debug: {
            rawTotal: allConversations.length,
            filteredTotal: filteredConversations.length,
            requestedPageId: pageId,
            pageIdBreakdown: Object.fromEntries(uniquePageIds),
            strategies: strategyLog,
            note: allConversations.length > 500
                ? `Multi-strategy fetch: vượt 500 cap! Lấy được ${allConversations.length} conversations`
                : batch1.conversations.length >= 500
                    ? "Hit 500 cap nhưng các strategy khác không tìm thêm được data mới"
                    : `Chỉ có ${allConversations.length} conversations (dưới 500 cap)`,
        },
    };
}

// ─── POS Customers fetcher (fallback) ─────────────────────────────────────────
async function fetchPOSCustomers(
    config: ScriptGeneratorConfig,
    shop: ShopConfig,
    _page: string,
    pageFilter: string
): Promise<NextResponse> {
    const pageSize = 50;
    const allCustomers: Array<Record<string, unknown>> = [];
    const seenIds = new Set<string>(); // Dedup giống CRM
    let currentPage = 1;
    let hasMore = true;
    const maxPages = 30;

    while (hasMore && currentPage <= maxPages) {
        const url = `${config.poscake.api_url}/shops/${shop.shop_id}/customers?api_key=${shop.api_key}&page=${currentPage}&page_size=${pageSize}`;

        try {
            const res = await fetch(url);
            if (!res.ok) {
                if (allCustomers.length === 0) {
                    return NextResponse.json({ error: `POS API lỗi: ${res.status}` }, { status: res.status });
                }
                break;
            }

            const data = await res.json();
            const batch = (data.data || []).map((c: PancakeCustomer) => ({
                id: c.id,
                customerName: c.name || "Không rõ tên",
                customerPhone: c.phone_numbers?.[0] || "",
                fbId: c.fb_id || "",
                psid: c.fb_id ? c.fb_id.split("_").slice(1).join("_") : "",
                pageFbId: c.fb_id ? c.fb_id.split("_")[0] : "",
                customerId: c.customer_id || "",
                conversationLink: c.conversation_link || "",
                orderCount: c.order_count || 0,
                messageCount: 0,
                snippet: "",
                tags: (c.tags || []).map((t: { name: string }) => t.name),
                address: c.shop_customer_addresses?.[0]?.full_address || "",
                updatedAt: c.updated_at || c.inserted_at || "",
                lastInteraction: "",
                source: "pos" as const,
            }));

            // Dedup: chỉ thêm customers chưa thấy
            let newCount = 0;
            for (const c of batch) {
                const cId = String(c.id || '');
                if (cId && !seenIds.has(cId)) {
                    seenIds.add(cId);
                    allCustomers.push(c);
                    newCount++;
                }
            }

            if (newCount === 0) {
                // Toàn duplicates → stop
                break;
            }

            if (batch.length < pageSize) {
                hasMore = false;
            } else {
                currentPage++;
            }
        } catch (err) {
            console.error(`[broadcast] POS fetch page ${currentPage} error:`, err);
            break;
        }
    }

    let customers = allCustomers;
    if (pageFilter) {
        customers = customers.filter((c: Record<string, unknown>) => c.pageFbId === pageFilter);
    }

    console.log(`[broadcast] POS loaded ${customers.length} customers (total fetched: ${allCustomers.length})`);

    return NextResponse.json({
        customers,
        total: customers.length,
        page: 1,
        totalPages: 1,
        source: "pos",
    });
}

// ─── POST: Gửi tin nhắn hàng loạt qua Pancake Public API ─────────────────────
interface BroadcastRequest {
    recipients: Array<{ psid: string; pageFbId: string; name: string; conversationId?: string }>;
    message: string;
    forceGraphAPI?: boolean;
}

// Generate Pancake Page Access Token
async function generatePageAccessToken(
    pageId: string,
    userToken: string
): Promise<string | null> {
    try {
        const res = await fetch(
            `https://pages.fm/api/v1/pages/${pageId}/generate_page_access_token?access_token=${userToken}`,
            { method: "POST" }
        );
        const data = await res.json();
        if (data.success && data.page_access_token) {
            return data.page_access_token;
        }
        console.error("[broadcast] Generate token failed:", data);
        return null;
    } catch (err) {
        console.error("[broadcast] Generate token error:", err);
        return null;
    }
}

// ─── Facebook Graph API: Get ALL Page Access Tokens ───────────────────────────
// Pancake page IDs ≠ Facebook page IDs → phải lấy tất cả từ /me/accounts
const fbAllPagesCache: { pages: Map<string, string>; byName: Map<string, string>; expires: number } = {
    pages: new Map(), byName: new Map(), expires: 0
};

async function loadFacebookPages(userAccessToken: string): Promise<void> {
    if (fbAllPagesCache.expires > Date.now()) return; // Cache valid
    
    fbAllPagesCache.pages.clear();
    fbAllPagesCache.byName.clear();
    
    let url = `https://graph.facebook.com/v21.0/me/accounts?access_token=${userAccessToken}&limit=100&fields=id,name,access_token`;
    let pageCount = 0;
    
    // Pagination — lấy hết tất cả pages
    while (url) {
        const res = await fetch(url);
        const data = await res.json();
        if (!data.data) break;
        
        for (const page of data.data) {
            if (page.access_token) {
                fbAllPagesCache.pages.set(String(page.id), page.access_token);
                // Cache by normalized name for fuzzy matching
                const normName = (page.name || '').toLowerCase().trim();
                fbAllPagesCache.byName.set(normName, page.access_token);
                pageCount++;
            }
        }
        
        url = data.paging?.next || '';
    }
    
    fbAllPagesCache.expires = Date.now() + 3600000; // Cache 1 giờ
    console.log(`[fb] Loaded ${pageCount} Facebook page tokens`);
}

async function getFacebookPageToken(pageId: string, userAccessToken: string, pageName?: string, configPageTokens?: Record<string, string>): Promise<string | null> {
    // 1. Ưu tiên page_tokens trực tiếp từ config (không cần /me/accounts)
    if (configPageTokens) {
        const directToken = configPageTokens[pageId];
        if (directToken) {
            console.log(`[fb] Using direct page token from config for pageId=${pageId}`);
            return directToken;
        }
        // Nếu config có page_tokens nhưng không có pageId cụ thể → dùng token đầu tiên làm fallback
        const firstConfigToken = Object.values(configPageTokens)[0];
        if (firstConfigToken) {
            console.log(`[fb] pageId=${pageId} not in config page_tokens → using first config token as fallback`);
            return firstConfigToken;
        }
    }

    // 2. Fallback: lookup qua /me/accounts
    await loadFacebookPages(userAccessToken);
    
    // Try by page ID first
    const byId = fbAllPagesCache.pages.get(pageId);
    if (byId) return byId;
    
    // Try by page name (fuzzy match — Pancake page name might match FB page name)
    if (pageName) {
        const normName = pageName.toLowerCase().trim();
        const byName = fbAllPagesCache.byName.get(normName);
        if (byName) return byName;
        
        // Partial match
        for (const [name, token] of fbAllPagesCache.byName) {
            if (name.includes(normName) || normName.includes(name)) return token;
        }
    }
    
    // 3. Last resort: try Graph API directly
    try {
        const res = await fetch(`https://graph.facebook.com/v21.0/${pageId}?fields=access_token&access_token=${userAccessToken}`);
        const data = await res.json();
        if (data.access_token) return data.access_token;
    } catch { /* ignore */ }
    
    // 4. Use first available token from /me/accounts
    const firstCachedToken = fbAllPagesCache.pages.values().next().value;
    if (firstCachedToken) {
        console.warn(`[fb] No exact match for pageId=${pageId} → using first cached token`);
        return firstCachedToken;
    }
    
    console.error(`[fb] No page token found for pageId=${pageId} name=${pageName}`);
    return null;
}

// ─── Facebook Graph API: Send Message via Send API ────────────────────────────
// Thử lần lượt nhiều message tags: HUMAN_AGENT → POST_PURCHASE_UPDATE → ACCOUNT_UPDATE → RESPONSE
// Error #100 = app chưa được approved tag đó → thử tag tiếp theo
async function sendViaFacebookGraphAPI(
    psid: string,
    messageText: string,
    pageAccessToken: string
): Promise<{ success: boolean; error?: string; messageId?: string; tagUsed?: string }> {
    const url = `https://graph.facebook.com/v21.0/me/messages?access_token=${pageAccessToken}`;
    const tokenPrefix = pageAccessToken.slice(0, 10);
    
    // Tag fallback chain
    const tagAttempts: Array<{ messaging_type: string; tag?: string; label: string }> = [
        { messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT",           label: "HUMAN_AGENT" },
        { messaging_type: "MESSAGE_TAG", tag: "POST_PURCHASE_UPDATE",   label: "POST_PURCHASE_UPDATE" },
        { messaging_type: "MESSAGE_TAG", tag: "ACCOUNT_UPDATE",         label: "ACCOUNT_UPDATE" },
        { messaging_type: "RESPONSE",                                    label: "RESPONSE" },
    ];

    const errors: string[] = [];
    for (const attempt of tagAttempts) {
        try {
            const body: Record<string, unknown> = {
                recipient: { id: psid },
                message: { text: messageText },
                messaging_type: attempt.messaging_type,
            };
            if (attempt.tag) body.tag = attempt.tag;

            console.log(`[fb-send] token=${tokenPrefix}... tag=${attempt.label} psid=${psid}`);
            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            const data = await res.json();

            if (data.error) {
                const code = data.error.code || data.error.error_code;
                const msg = data.error.message || JSON.stringify(data.error);
                const errEntry = `${attempt.label}[#${code}]:${msg.slice(0, 80)}`;
                console.warn(`[fb-send] FAIL ${errEntry}`);
                errors.push(errEntry);
                // #100/#200 = no permission for tag → try next
                // #10 = outside window → try next
                // #190 = invalid/wrong token format (e.g. Pancake token used w/ Graph API)
                if (code === 100 || code === 200 || code === 10 || code === 190 ||
                    String(code) === '100' || String(code) === '200' || String(code) === '10' || String(code) === '190') {
                    continue;
                }
                // Fatal errors (#551 blocked, #613 rate limit) → stop
                return { success: false, error: `FB API: ${errEntry}` };
            }

            if (data.recipient_id && data.message_id) {
                console.log(`[fb-send] ✅ tag=${attempt.label} token=${tokenPrefix}...`);
                return { success: true, messageId: data.message_id, tagUsed: attempt.label };
            }

            errors.push(`${attempt.label}:unexpected=${JSON.stringify(data).slice(0, 50)}`);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[fb-send] Exception ${attempt.label}:`, msg);
            errors.push(`${attempt.label}:exception=${msg.slice(0, 50)}`);
        }
    }

    const errSummary = errors.join(' | ');
    console.error(`[fb-send] All tags exhausted. PSID=${psid} token=${tokenPrefix}... | ${errSummary}`);
    return { success: false, error: `FB API (tất cả tags thất bại): ${errSummary}` };
}

// ─── Facebook Graph API: Send Image Attachment ────────────────────────────────
async function sendImageViaFacebookGraphAPI(
    psid: string,
    imageUrl: string,
    pageAccessToken: string
): Promise<{ success: boolean; error?: string }> {
    try {
        const url = `https://graph.facebook.com/v21.0/me/messages?access_token=${pageAccessToken}`;
        const body = {
            recipient: { id: psid },
            message: {
                attachment: {
                    type: "image",
                    payload: { url: imageUrl, is_reusable: true },
                },
            },
            messaging_type: "MESSAGE_TAG",
            tag: "HUMAN_AGENT",
        };

        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        const data = await res.json();

        if (data.error) {
            return { success: false, error: `FB Image: ${data.error.message}` };
        }
        return { success: true };
    } catch (err) {
        return { success: false, error: `FB Image Error: ${err instanceof Error ? err.message : String(err)}` };
    }
}


// ─── Facebook Graph API: Send Image Direct (binary upload, không cần hosting) ─
async function sendImageDirectViaFacebookGraphAPI(
    psid: string,
    imageBuffer: Buffer,
    fileName: string,
    mimeType: string,
    pageAccessToken: string
): Promise<{ success: boolean; error?: string; messageId?: string }> {
    const url = `https://graph.facebook.com/v21.0/me/messages?access_token=${pageAccessToken}`;

    const tagAttempts: Array<{ messaging_type: string; tag?: string; label: string }> = [
        { messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT", label: "HUMAN_AGENT" },
        { messaging_type: "MESSAGE_TAG", tag: "POST_PURCHASE_UPDATE", label: "POST_PURCHASE_UPDATE" },
        { messaging_type: "RESPONSE", label: "RESPONSE" },
    ];

    for (const attempt of tagAttempts) {
        try {
            const fd = new FormData();
            fd.append('recipient', JSON.stringify({ id: psid }));
            fd.append('message', JSON.stringify({
                attachment: { type: "image", payload: { is_reusable: true } }
            }));
            fd.append('messaging_type', attempt.messaging_type);
            if (attempt.tag) fd.append('tag', attempt.tag);

            const blob = new Blob([imageBuffer], { type: mimeType });
            fd.append('filedata', blob, fileName);

            const res = await fetch(url, { method: "POST", body: fd });
            const data = await res.json();

            if (data.error) {
                const code = data.error.code || data.error.error_code;
                if (code === 100 || code === 200 || code === 10 || code === 190) continue;
                return { success: false, error: `FB Image [${attempt.label}]: ${data.error.message}` };
            }
            if (data.message_id) {
                console.log(`[fb-img] ✅ Direct upload OK via ${attempt.label} for PSID=${psid}`);
                return { success: true, messageId: data.message_id };
            }
        } catch (err) {
            console.error(`[fb-img] Exception ${attempt.label}:`, err instanceof Error ? err.message : err);
            continue;
        }
    }

    return { success: false, error: "FB Image Direct: tất cả tags thất bại" };
}

// ─── Helper: Upload ảnh lên LOCAL SERVER (primary — tự host, không phụ thuộc dịch vụ ngoài) ─
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";

const UPLOAD_DIR = path.resolve(process.cwd(), "public/uploads");
// PUBLIC_URL dùng cho ảnh upload — phải là URL mà Pancake/Facebook truy cập được (KHÔNG phải localhost)
const APP_URL = process.env.PUBLIC_URL || "http://139.180.131.21:8089";

// Đọc ảnh từ disk thay vì fetch HTTP (tránh deadlock khi server tự fetch chính nó)
function readLocalImage(imgUrl: string): Buffer | null {
    try {
        // Nếu URL là local server → đọc trực tiếp từ disk
        if (imgUrl.includes('/uploads/')) {
            const filename = imgUrl.split('/uploads/').pop();
            if (filename) {
                const filePath = path.join(UPLOAD_DIR, filename);
                if (existsSync(filePath)) {
                    return readFileSync(filePath);
                }
            }
        }
        return null;
    } catch {
        return null;
    }
}

async function getImageBuffer(imgUrl: string): Promise<Buffer | null> {
    // Thử đọc từ disk trước (nhanh, không deadlock)
    const localBuf = readLocalImage(imgUrl);
    if (localBuf) return localBuf;
    // Nếu không phải local → fetch từ URL bên ngoài
    try {
        const res = await fetch(imgUrl);
        if (res.ok) return Buffer.from(await res.arrayBuffer());
    } catch { /* ignore */ }
    return null;
}

async function uploadToLocalServer(base64: string): Promise<string> {
    try {
        // Đảm bảo thư mục uploads tồn tại
        if (!existsSync(UPLOAD_DIR)) {
            mkdirSync(UPLOAD_DIR, { recursive: true });
        }
        
        const buffer = Buffer.from(base64, "base64");
        const filename = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`;
        const filePath = path.join(UPLOAD_DIR, filename);
        
        writeFileSync(filePath, buffer);
        
        const publicUrl = `${APP_URL}/uploads/${filename}`;
        console.log(`[upload] ✅ Local saved: ${publicUrl}`);
        return publicUrl;
    } catch (err) {
        console.error("[upload] Local save error:", err instanceof Error ? err.message : err);
        return "";
    }
}

// ─── Helper: Upload ảnh lên freeimage.host (fallback 1) ─
async function uploadToFreeImageHost(base64: string): Promise<string> {
    try {
        const uploadFd = new FormData();
        uploadFd.append('source', base64);
        uploadFd.append('type', 'base64');
        uploadFd.append('action', 'upload');
        const uploadRes = await fetch('https://freeimage.host/api/1/upload?key=6d207e02198a847aa98d0a2a901485a5', {
            method: 'POST', body: uploadFd,
        });
        const uploadData = await uploadRes.json().catch(() => ({}));
        return uploadData?.image?.url || '';
    } catch (err) {
        console.error('[upload] freeimage.host error:', err instanceof Error ? err.message : err);
        return '';
    }
}

// ─── Helper: Upload ảnh lên imgbb.com (fallback 2) ─
async function uploadToImgBB(base64: string): Promise<string> {
    try {
        const uploadFd = new FormData();
        uploadFd.append('image', base64);
        const uploadRes = await fetch('https://api.imgbb.com/1/upload?key=3e45a6f8c4e5d6a7b8c9d0e1f2a3b4c5', {
            method: 'POST', body: uploadFd,
        });
        const uploadData = await uploadRes.json().catch(() => ({}));
        return uploadData?.data?.url || '';
    } catch (err) {
        console.error('[upload] imgbb error:', err instanceof Error ? err.message : err);
        return '';
    }
}

// ═══ SERVER-SIDE DEDUP CACHE ═══
// Chống gửi lặp: từ chối gửi cùng PSID + cùng message trong 10 phút
const DEDUP_WINDOW_MS = 10 * 60 * 1000; // 10 phút (tăng từ 2 phút để chặn retry lặp)
const sentCache = new Map<string, number>(); // psid -> timestamp

function cleanupDedup() {
    const now = Date.now();
    for (const [key, ts] of sentCache) {
        if (now - ts > DEDUP_WINDOW_MS) sentCache.delete(key);
    }
    // Cleanup image cache too (30 min TTL)
    for (const [key, entry] of imageUrlCache) {
        if (now - entry.ts > 30 * 60 * 1000) imageUrlCache.delete(key);
    }
}

// ═══ IMAGE URL CACHE ═══
// Cache uploaded image URLs to avoid re-uploading the same image
const imageUrlCache = new Map<string, { url: string; ts: number }>();

function getImageHash(data: string): string {
    // Simple hash based on first/last 100 chars + length (fast, good enough for dedup)
    const len = data.length;
    return `${len}_${data.slice(0, 100)}_${data.slice(-100)}`;
}

async function uploadImageOnce(base64: string): Promise<string> {
    const hash = getImageHash(base64);
    const cached = imageUrlCache.get(hash);
    if (cached) {
        console.log(`[img-cache] ✅ Cache hit: ${cached.url}`);
        return cached.url;
    }
    
    // Primary: local server (nginx serve static - đã hoạt động trước đây!)
    let url = await uploadToLocalServer(base64);
    // Fallback 1: freeimage.host
    if (!url) url = await uploadToFreeImageHost(base64);
    // Fallback 2: imgbb
    if (!url) url = await uploadToImgBB(base64);
    
    if (url) {
        imageUrlCache.set(hash, { url, ts: Date.now() });
        console.log(`[img-cache] Uploaded & cached: ${url}`);
    } else {
        console.error(`[img-cache] ❌ ALL upload methods failed`);
    }
    return url;
}

export async function POST(req: NextRequest) {
    try {
        const config = loadConfig();
        
        // Parse body: hỗ trợ cả JSON lẫn FormData (multipart)
        let recipients: Array<{ psid: string; pageFbId: string; name: string; conversationId?: string }>;
        let message: string;
        let forceGraphAPI = false;
        let imageFiles: File[] = []; // File objects from FormData
        let imageStrings: string[] = []; // base64 strings from JSON

        const contentType = req.headers.get('content-type') || '';
        if (contentType.includes('multipart/form-data')) {
            const formData = await req.formData();
            recipients = JSON.parse(formData.get('recipients') as string || '[]');
            message = (formData.get('message') as string) || '';
            forceGraphAPI = formData.get('forceGraphAPI') === 'true';
            // getAll trả về tất cả files gửi với key 'images'
            const imgEntries = formData.getAll('images');
            for (const entry of imgEntries) {
                if (entry instanceof File) {
                    imageFiles.push(entry);
                }
            }
            console.log(`[broadcast] FormData: ${recipients.length} recipients, ${imageFiles.length} image files, forceGraphAPI=${forceGraphAPI}`);
        } else {
            const body = await req.json();
            recipients = body.recipients;
            message = body.message || '';
            imageStrings = body.images || [];
            forceGraphAPI = body.forceGraphAPI === true;
        }

        const hasImages = imageFiles.length > 0 || imageStrings.length > 0;
        if (!recipients?.length || (!message?.trim() && !hasImages)) {
            return NextResponse.json(
                { error: "Thiếu thông tin: recipients, message hoặc images" },
                { status: 400 }
            );
        }

        const crmToken = config.pancake_crm?.api_token;
        if (!crmToken && !forceGraphAPI) {
            return NextResponse.json(
                { error: "Chưa cấu hình pancake_crm.api_token trong config." },
                { status: 500 }
            );
        }

        // Facebook Graph API token (for fallback or force mode)
        // Prefer meta_ads token (Ads app) over facebook_messaging token (Chat page app) since the latter was deleted
        const fbUserToken = config.meta_ads?.access_token || config.facebook_messaging?.user_access_token;
        const hasFbToken = !!fbUserToken; console.log("[DEBUG] hasFbToken:", hasFbToken, "fbUserToken length:", fbUserToken?.length);

        // Group recipients by page to generate tokens per page
        const pageGroups = new Map<string, typeof recipients>();
        for (const r of recipients) {
            const pageId = r.pageFbId;
            if (!pageGroups.has(pageId)) pageGroups.set(pageId, []);
            pageGroups.get(pageId)!.push(r);
        }

        // Generate page tokens (Pancake)
        const pageTokens = new Map<string, string>();
        if (crmToken) {
            for (const pageId of pageGroups.keys()) {
                const token = await generatePageAccessToken(pageId, crmToken);
                if (token) pageTokens.set(pageId, token);
            }
        }

        const results: Array<{
            psid: string;
            name: string;
            success: boolean;
            error?: string;
            via?: 'pancake' | 'fb_graph_api';
        }> = [];

        // Pre-load Facebook page tokens if needed
        const fbPageTokens = new Map<string, string>();
        const configPageTokens = config.facebook_messaging?.page_tokens;
        if (hasFbToken && fbUserToken) {
            try {
                for (const pageId of pageGroups.keys()) {
                    const fbToken = await getFacebookPageToken(pageId, fbUserToken, undefined, configPageTokens);
                    if (fbToken) {
                        fbPageTokens.set(pageId, fbToken);
                        console.log(`[fb] Resolved token for pageId=${pageId}`);
                    }
                }
                console.log(`[fb] Pre-loaded ${fbPageTokens.size} FB page tokens`);
            } catch (err) {
                console.error('[fb] Failed to pre-load FB page tokens:', err);
            }
        }

        // Cleanup dedup cache
        cleanupDedup();

        // ═══ PRE-PROCESS: Chuyển ảnh thành Buffer để gửi trực tiếp qua FB Graph API ═══
        // Gửi ảnh dạng binary attachment (hiện ảnh trực tiếp trong chat, KHÔNG phải link URL)
        const imageBuffers: { buffer: Buffer; name: string; type: string }[] = [];
        if (hasImages) {
            console.log(`[img] Preparing ${imageFiles.length + imageStrings.length} images as buffers for direct send...`);
            
            for (let i = 0; i < imageFiles.length; i++) {
                const f = imageFiles[i];
                const arrBuf = await f.arrayBuffer();
                const ext = f.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
                imageBuffers.push({
                    buffer: Buffer.from(arrBuf),
                    name: `image_${i}.${ext}`,
                    type: f.type || 'image/png',
                });
            }
            for (const s of imageStrings) {
                if (s.startsWith('data:')) {
                    const m = s.match(/^data:([^;]+);base64,(.+)$/);
                    if (m) {
                        const ext = m[1].split('/')[1]?.replace('jpeg', 'jpg') || 'png';
                        imageBuffers.push({
                            buffer: Buffer.from(m[2], 'base64'),
                            name: `image_${imageBuffers.length}.${ext}`,
                            type: m[1],
                        });
                    }
                } else if (s.startsWith('http')) {
                    // Download URL to buffer
                    try {
                        const res = await fetch(s);
                        if (res.ok) {
                            imageBuffers.push({
                                buffer: Buffer.from(await res.arrayBuffer()),
                                name: `image_${imageBuffers.length}.png`,
                                type: res.headers.get('content-type') || 'image/png',
                            });
                        }
                    } catch { /* ignore */ }
                }
            }
            
            console.log(`[img] Ready: ${imageBuffers.length} image buffers (sizes: ${imageBuffers.map(b => `${(b.buffer.length/1024).toFixed(0)}KB`).join(', ')})`);
        }

        // Create message fingerprint for dedup (different messages = different segments = OK)
        const msgFingerprint = message ? message.slice(0, 50) : '';
        
        for (const recipient of recipients) {
            // ═══ DEDUP CHECK: đã gửi cùng tin nhắn cho PSID này trong 2 phút? ═══
            // Key bao gồm message fingerprint để segment khác nhau KHÔNG bị chặn
            const dedupKey = `${recipient.psid}_${recipient.pageFbId}_${msgFingerprint}`;
            if (sentCache.has(dedupKey)) {
                const lastSent = sentCache.get(dedupKey)!;
                const secsAgo = Math.round((Date.now() - lastSent) / 1000);
                console.log(`[DEDUP] BLOCKED: ${recipient.name} (${recipient.psid}) - đã gửi ${secsAgo}s trước`);
                results.push({ psid: recipient.psid, name: recipient.name, success: false, error: `⚠️ Đã gửi ${secsAgo}s trước (chặn lặp)` });
                continue;
            }
            // Mark as sent TRƯỚC khi gửi
            sentCache.set(dedupKey, Date.now());
            try {
                const pageId = recipient.pageFbId;
                const pageToken = pageTokens.get(pageId);
                const fbPageToken = fbPageTokens.get(pageId);

                // ═══ FORCE GRAPH API MODE ═══
                if (forceGraphAPI) {
                    if (!fbPageToken) {
                        results.push({ psid: recipient.psid, name: recipient.name, success: false, error: `❌ Không có FB token cho page ${pageId}`, via: 'fb_graph_api' });
                        continue;
                    }
                    let textOk = true;
                    let imgOk = true;

                    if (message?.trim()) {
                        const fbResult = await sendViaFacebookGraphAPI(recipient.psid, message.trim(), fbPageToken);
                        textOk = fbResult.success;
                        if (!textOk) {
                            results.push({ psid: recipient.psid, name: recipient.name, success: false, error: fbResult.error, via: 'fb_graph_api' });
                            await new Promise(r => setTimeout(r, 500));
                            continue;
                        }
                    }

                    // Images via Graph API — Direct binary upload (gửi ảnh trực tiếp)
                    if (imageFiles.length > 0 || imageStrings.length > 0) {
                        const filesToSend: { buffer: Buffer; type: string; name: string }[] = [];
                        for (const f of imageFiles) {
                            const arrBuf = await f.arrayBuffer();
                            const ext = f.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
                            filesToSend.push({ buffer: Buffer.from(arrBuf), type: f.type, name: `img_${filesToSend.length}.${ext}` });
                        }
                        for (const s of imageStrings) {
                            if (s.startsWith('data:')) {
                                const m = s.match(/^data:([^;]+);base64,(.+)$/);
                                if (m) {
                                    const ext = m[1].split('/')[1]?.replace('jpeg', 'jpg') || 'png';
                                    filesToSend.push({ buffer: Buffer.from(m[2], 'base64'), type: m[1], name: `img_${filesToSend.length}.${ext}` });
                                }
                            }
                        }
                        for (const file of filesToSend) {
                            try {
                                const imgResult = await sendImageDirectViaFacebookGraphAPI(
                                    recipient.psid, file.buffer, file.name, file.type, fbPageToken
                                );
                                if (!imgResult.success) {
                                    console.warn(`[fb-img] Direct failed, fallback URL: ${imgResult.error}`);
                                    // Fallback: freeimage.host → URL
                                    const fallbackResult = await sendImageViaFacebookGraphAPI(
                                        recipient.psid,
                                        await uploadToFreeImageHost(file.buffer.toString('base64')),
                                        fbPageToken
                                    );
                                    if (!fallbackResult.success) imgOk = false;
                                }
                                await new Promise(r => setTimeout(r, 300));
                            } catch { imgOk = false; }
                        }
                    }

                    if (textOk && imgOk) {
                        results.push({ psid: recipient.psid, name: recipient.name, success: true, via: 'fb_graph_api' });
                    } else if (textOk) {
                        results.push({ psid: recipient.psid, name: recipient.name, success: true, error: '⚠️ Text OK, ảnh lỗi', via: 'fb_graph_api' });
                    } else {
                        results.push({ psid: recipient.psid, name: recipient.name, success: false, error: 'Gửi thất bại', via: 'fb_graph_api' });
                    }
                    await new Promise(r => setTimeout(r, 500));
                    continue;
                }

                // ═══ NORMAL MODE: Pancake first, FB Graph API fallback ═══
                if (!pageToken) {
                    // No Pancake token → try FB Graph API directly
                    if (fbPageToken && message?.trim()) {
                        console.log(`[fb-fallback] No Pancake token for page ${pageId}, trying FB Graph API directly`);
                        const fbResult = await sendViaFacebookGraphAPI(recipient.psid, message.trim(), fbPageToken);
                        results.push({ psid: recipient.psid, name: recipient.name, success: fbResult.success, error: fbResult.error, via: 'fb_graph_api' });
                    } else {
                        results.push({ psid: recipient.psid, name: recipient.name, success: false, error: `Không tạo được token cho page ${pageId}` });
                    }
                    continue;
                }

                const convoId = recipient.conversationId || `${pageId}_${recipient.psid}`;
                const apiBase = `https://pages.fm/api/public_api/v1/pages/${pageId}/conversations/${convoId}/messages?page_access_token=${pageToken}`;

                // ═══ DEBUG: Log full request details ═══
                console.log(`[broadcast][DEBUG] ━━━ SEND TO: ${recipient.name} (${recipient.psid}) ━━━`);
                console.log(`[broadcast][DEBUG] pageId=${pageId}, convoId=${convoId}`);
                console.log(`[broadcast][DEBUG] URL=${apiBase.replace(pageToken, 'TOKEN_HIDDEN')}`);
                console.log(`[broadcast][DEBUG] conversationId from recipient: ${recipient.conversationId || 'MISSING (fallback used)'}`);

                let textSuccess = true;
                let imageSuccess = true;
                let sentVia: 'pancake' | 'fb_graph_api' = 'pancake';

                // 1. Gửi tin nhắn text trước
                if (message?.trim()) {
                    const reqBody = {
                        action: "reply_inbox",
                        message: message.trim(),
                    };
                    console.log(`[broadcast][DEBUG] Request body:`, JSON.stringify(reqBody));
                    
                    const sendRes = await fetch(apiBase, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(reqBody),
                    });
                    const sendText = await sendRes.text();
                    console.log(`[broadcast][DEBUG] Response status=${sendRes.status}, body=${sendText.slice(0, 500)}`);
                    
                    let sendData: Record<string, unknown> = {};
                    try { sendData = JSON.parse(sendText); } catch { sendData = { raw: sendText.slice(0, 200) }; }
                    
                    if (!sendData.success) {
                        // ═══ FB GRAPH API FALLBACK: Try HUMAN_AGENT tag (7 days window) ═══
                        const errMsg = String(sendData.original_error || sendData.message || sendData.error || '');
                        const errCode = sendData.error_code || sendData.code || '';
                        
                        // ═══ EXPANDED: Detect ALL messaging errors that should trigger FB fallback ═══
                        // #10  = outside 24h window (OOW)
                        // #551 = "Người này hiện không có mặt" / user not available  
                        // #100 = invalid parameter / no matching user
                        // #200 = permission error
                        // #2018001 = message delivery failed
                        // Generic: Cannot send, blocked, unavailable
                        const shouldFallbackToFB = 
                            // Error #10: outside 24h window
                            errMsg.includes('(#10)') ||
                            errMsg.includes('error_code=10') ||
                            /\berror[^\w]*10\b/i.test(errMsg) ||
                            errCode === 10 || errCode === '10' ||
                            // Error #551: user not available / không có mặt
                            errMsg.includes('(#551)') ||
                            errCode === 551 || errCode === '551' ||
                            errMsg.toLowerCase().includes('không có mặt') ||
                            errMsg.toLowerCase().includes('not available') ||
                            errMsg.toLowerCase().includes('unavailable') ||
                            // Error #100: invalid parameter 
                            errMsg.includes('(#100)') ||
                            errCode === 100 || errCode === '100' ||
                            // Error #200: permission
                            errMsg.includes('(#200)') ||
                            errCode === 200 || errCode === '200' ||
                            // Error #2018001: delivery failed
                            errMsg.includes('(#2018001)') ||
                            errCode === 2018001 || errCode === '2018001' ||
                            // Generic patterns
                            errMsg.toLowerCase().includes('outside') ||
                            errMsg.toLowerCase().includes('ngoài khoảng') ||
                            errMsg.toLowerCase().includes('ngoai khoang') ||
                            errMsg.includes('Cannot send') ||
                            errMsg.includes('OOW') ||
                            errMsg.toLowerCase().includes('24-hour') ||
                            errMsg.toLowerCase().includes('24h') ||
                            errMsg.toLowerCase().includes('blocked') ||
                            errMsg.toLowerCase().includes('bị chặn');
                        
                        // ═══ ALWAYS try FB fallback when Pancake fails ═══
                        // Nếu không match pattern cụ thể → vẫn thử FB nếu có token
                        const hasFbFallback = !!fbPageToken;
                        
                        if (shouldFallbackToFB || hasFbFallback) {
                            // Validate PSID: phải là số thuần, không phải Pancake internal ID
                            const psidToUse = recipient.psid;
                            const isValidPSID = /^\d+$/.test(psidToUse) && psidToUse.length >= 10;
                            
                            if (!isValidPSID) {
                                console.warn(`[fb-fallback] ⚠️ INVALID PSID: "${psidToUse}" for ${recipient.name} — looks like Pancake internal ID, not Facebook PSID`);
                                textSuccess = false;
                                results.push({ psid: recipient.psid, name: recipient.name, success: false, error: `Pancake: ${errMsg} → PSID không hợp lệ (${psidToUse}) — không phải Facebook PSID`, via: 'pancake' });
                                await new Promise((resolve) => setTimeout(resolve, 500));
                                continue;
                            }
                            
                            // Chỉ dùng TalphaBot token — Pancake token không dùng được với Graph API (#190)
                            const tokensToTry: Array<{ token: string; label: string }> = [];
                            if (fbPageToken) tokensToTry.push({ token: fbPageToken, label: 'TalphaBot' });

                            const fallbackReason = shouldFallbackToFB ? 'matched error pattern' : 'generic Pancake failure';
                            console.log(`[fb-fallback] ${recipient.name} | PSID=${psidToUse} | pageId=${pageId} | reason=${fallbackReason} | pancakeErr=${errMsg.slice(0, 80)} | tokens=${tokensToTry.map(t=>t.label).join(',')||'NONE'}`);

                            let fbSuccess = false;
                            let fbError = '';
                            for (const { token: tryToken, label } of tokensToTry) {
                                console.log(`[fb-fallback] Trying ${label} token for ${recipient.name} (PSID=${psidToUse})`);
                                const fbResult = await sendViaFacebookGraphAPI(psidToUse, message.trim(), tryToken);
                                if (fbResult.success) {
                                    fbSuccess = true;
                                    textSuccess = true;
                                    sentVia = 'fb_graph_api';
                                    console.log(`[fb-fallback] ✅ SUCCESS via ${label} for ${recipient.name} (tag=${fbResult.tagUsed})`);
                                    break;
                                }
                                fbError = `${label}: ${fbResult.error || ''}`;
                                console.warn(`[fb-fallback] ${label} failed for ${recipient.name}: ${fbResult.error}`);
                            }

                            if (!fbSuccess) {
                                textSuccess = false;
                                results.push({ psid: recipient.psid, name: recipient.name, success: false, error: `Pancake: ${errMsg.slice(0, 60)} → FB: ${fbError || 'Không có token'}`, via: 'fb_graph_api' });
                                await new Promise((resolve) => setTimeout(resolve, 500));
                                continue;
                            }
                        } else {
                            textSuccess = false;
                            const displayErr = sendData.original_error || sendData.message || `HTTP ${sendRes.status}`;
                            results.push({ psid: recipient.psid, name: recipient.name, success: false, error: `Text: ${String(displayErr)}`, via: 'pancake' });
                            await new Promise((resolve) => setTimeout(resolve, 500));
                            continue;
                        }
                    }
                }

                // 2. Gửi hình ảnh
                if (imageBuffers.length > 0) {
                    for (let imgIdx = 0; imgIdx < imageBuffers.length; imgIdx++) {
                        try {
                            const file = imageBuffers[imgIdx];
                            let imgSent = false;
                            
                            // ═══ METHOD 1 (PRIMARY): Pancake upload_contents → content_ids ═══
                            // Step 1: Upload ảnh lên Pancake server lấy content_id
                            // Step 2: Gửi tin nhắn với content_ids
                            if (pageToken && !imgSent) {
                                try {
                                    // Step 1: Upload ảnh lên Pancake
                                    const uploadUrl = `https://pages.fm/api/public_api/v1/pages/${pageId}/upload_contents?page_access_token=${pageToken}`;
                                    const uploadFd = new FormData();
                                    const blob = new Blob([file.buffer], { type: file.type });
                                    uploadFd.append('file', blob, file.name);
                                    
                                    console.log(`[img] Pancake upload_contents img${imgIdx} (${(file.buffer.length/1024).toFixed(0)}KB)...`);
                                    const uploadRes = await fetch(uploadUrl, {
                                        method: "POST",
                                        body: uploadFd,
                                    });
                                    const uploadData = await uploadRes.json().catch(() => ({}));
                                    console.log(`[img] Pancake upload response:`, JSON.stringify(uploadData).slice(0, 200));
                                    
                                    // Tìm content_id từ response (có thể trả về dạng khác nhau)
                                    const contentId = uploadData?.id || uploadData?.content_id || uploadData?.data?.id || uploadData?.data?.content_id;
                                    
                                    if (contentId) {
                                        // Step 2: Gửi tin nhắn với content_ids
                                        const sendImgRes = await fetch(apiBase, {
                                            method: "POST",
                                            headers: { "Content-Type": "application/json" },
                                            body: JSON.stringify({
                                                action: "reply_inbox",
                                                content_ids: [contentId],
                                            }),
                                        });
                                        const sendImgData = await sendImgRes.json().catch(() => ({}));
                                        if (sendImgData.success) {
                                            console.log(`[img] ✅ Pancake content_ids img${imgIdx} for ${recipient.name}`);
                                            imgSent = true;
                                        } else {
                                            console.warn(`[img] Pancake content_ids send failed:`, JSON.stringify(sendImgData).slice(0, 150));
                                        }
                                    } else {
                                        console.warn(`[img] Pancake upload_contents no content_id in response`);
                                    }
                                } catch (e) {
                                    console.error(`[img] Pancake upload_contents exception:`, e instanceof Error ? e.message : e);
                                }
                            }
                            
                            // ═══ METHOD 2: Pancake content_url (upload to external host) ═══
                            if (!imgSent && pageToken) {
                                try {
                                    console.log(`[img] Trying Pancake content_url fallback...`);
                                    const uploadUrl = await uploadImageOnce(file.buffer.toString('base64'));
                                    if (uploadUrl) {
                                        // Thử content_url trước
                                        const pancakeImgRes = await fetch(apiBase, {
                                            method: "POST",
                                            headers: { "Content-Type": "application/json" },
                                            body: JSON.stringify({ action: "reply_inbox", content_url: uploadUrl }),
                                        });
                                        const pancakeImgData = await pancakeImgRes.json().catch(() => ({}));
                                        // Kiểm tra THỰC SỰ thành công (Pancake đôi khi nói success nhưng ảnh broken)
                                        if (pancakeImgData.success && !pancakeImgData.original_error) {
                                            console.log(`[img] ✅ Pancake content_url img${imgIdx} for ${recipient.name}`);
                                            imgSent = true;
                                        } else {
                                            console.warn(`[img] Pancake content_url issue:`, pancakeImgData.original_error || pancakeImgData.message || JSON.stringify(pancakeImgData).slice(0, 100));
                                            // Fallback: Gửi URL qua field message
                                            const pancakeImgRes2 = await fetch(apiBase, {
                                                method: "POST",
                                                headers: { "Content-Type": "application/json" },
                                                body: JSON.stringify({ action: "reply_inbox", message: uploadUrl }),
                                            });
                                            const pancakeImgData2 = await pancakeImgRes2.json().catch(() => ({}));
                                            if (pancakeImgData2.success) {
                                                console.log(`[img] ✅ Pancake message-url img${imgIdx} for ${recipient.name}`);
                                                imgSent = true;
                                            }
                                        }
                                    }
                                } catch { /* ignore */ }
                            }

                            // ═══ METHOD 3: FB Graph API direct binary upload ═══
                            if (!imgSent && fbPageToken) {
                                const imgResult = await sendImageDirectViaFacebookGraphAPI(
                                    recipient.psid, file.buffer, file.name, file.type, fbPageToken
                                );
                                if (imgResult.success) {
                                    console.log(`[img] ✅ FB Direct upload img${imgIdx} for ${recipient.name}`);
                                    sentVia = 'fb_graph_api';
                                    imgSent = true;
                                } else {
                                    console.warn(`[img] FB Direct upload failed: ${imgResult.error}`);
                                }
                            }

                            if (!imgSent) {
                                imageSuccess = false;
                                console.error(`[img] ❌ ALL methods failed for img${imgIdx} of ${recipient.name}`);
                            }
                            
                            await new Promise(resolve => setTimeout(resolve, 300));
                        } catch (imgErr) {
                            imageSuccess = false;
                            console.error(`[img] Exception img${imgIdx}:`, imgErr instanceof Error ? imgErr.message : imgErr);
                        }
                    }
                }

                if (textSuccess && imageSuccess) {
                    results.push({ psid: recipient.psid, name: recipient.name, success: true, via: sentVia });
                } else if (textSuccess && !imageSuccess) {
                    results.push({ psid: recipient.psid, name: recipient.name, success: true, error: "⚠️ Text OK, ảnh lỗi", via: sentVia });
                } else {
                    results.push({ psid: recipient.psid, name: recipient.name, success: false, error: "Gửi thất bại", via: sentVia });
                }

                // Delay 500ms between recipients
                await new Promise((resolve) => setTimeout(resolve, 500));
            } catch (err: unknown) {
                results.push({
                    psid: recipient.psid,
                    name: recipient.name,
                    success: false,
                    error: err instanceof Error ? err.message : "Network error",
                });
            }
        }

        const successCount = results.filter((r) => r.success).length;

        return NextResponse.json({
            success: successCount > 0,
            message: `✅ Đã gửi ${successCount}/${results.length} tin nhắn`,
            successCount,
            totalCount: results.length,
            results,
        });
    } catch (error: unknown) {
        console.error("[broadcast] POST Error:", error);
        const errMessage = error instanceof Error ? error.message : "Unknown error";
        return NextResponse.json({ error: errMessage }, { status: 500 });
    }
}
