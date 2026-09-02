import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "../lib/logger.js";
import { fetchJson } from "../lib/http.js";

/**
 * Client Pancake POS — nguồn sự thật về ĐƠN HÀNG.
 *
 * POS là hệ thống riêng, tách khỏi CRM hội thoại: mỗi shop có api_key + shop_id
 * của mình, và một shop phục vụ nhiều page. Khoá để trong config/pos-shops.json
 * (đã gitignore) thay vì .env vì có tới 8 shop, sửa file dễ hơn sửa biến môi trường.
 *
 * Không có file khoá → POS bị tắt lặng lẽ, hệ thống vẫn chạy bình thường và
 * chỉ bắt đơn qua webhook + tag mua hàng như trước.
 */

const log = logger.child({ client: "pos" });

const API_URL = process.env.POS_API_URL || "https://pos.pages.fm/api/v1";
const CONFIG_PATH = resolve(process.cwd(), "config/pos-shops.json");

export interface PosShop {
    name: string;
    shop_id: string;
    api_key: string;
}

let shopsCache: PosShop[] | null = null;

/** Danh sách shop POS đã cấu hình. Mảng rỗng nghĩa là POS tắt. */
export function loadShops(): PosShop[] {
    if (shopsCache) return shopsCache;

    if (!existsSync(CONFIG_PATH)) {
        log.info({ path: CONFIG_PATH }, "Không có config/pos-shops.json — bỏ qua đối chiếu POS");
        shopsCache = [];
        return shopsCache;
    }

    try {
        const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as unknown;
        if (!Array.isArray(raw)) throw new Error("File phải là một mảng shop");

        const shops: PosShop[] = [];
        for (const [i, item] of raw.entries()) {
            const o = item as Record<string, unknown>;
            const name = String(o.name ?? `Shop ${i + 1}`);
            const shopId = String(o.shop_id ?? "");
            const apiKey = String(o.api_key ?? "");
            if (!shopId || !apiKey || apiKey.startsWith("<")) {
                log.warn({ name }, "Shop thiếu shop_id hoặc api_key — bỏ qua");
                continue;
            }
            shops.push({ name, shop_id: shopId, api_key: apiKey });
        }
        shopsCache = shops;
        log.info({ count: shops.length }, "Đã nạp shop POS");
        return shops;
    } catch (err) {
        log.error({ err: err instanceof Error ? err.message : String(err) }, "Đọc config/pos-shops.json lỗi — bỏ qua POS");
        shopsCache = [];
        return shopsCache;
    }
}

export function findShop(shopId: string): PosShop | null {
    return loadShops().find((s) => s.shop_id === shopId) ?? null;
}

export function isEnabled(): boolean {
    return loadShops().length > 0;
}

// ─── Khách hàng POS ───────────────────────────────────────────────────────────

interface RawPosCustomer {
    id?: string;
    name?: string;
    /** Dạng "{pageId}_{psid}" — đây là cầu nối duy nhất sang tệp khách của mình */
    fb_id?: string;
    phone_numbers?: string[];
    order_count?: number;
    updated_at?: string;
    inserted_at?: string;
}

export interface PosCustomer {
    pageId: string;
    psid: string;
    name: string | null;
    phone: string | null;
    orderCount: number;
    updatedAt: Date | null;
}

/** Tách "{pageId}_{psid}" — psid có thể chứa dấu gạch dưới nên chỉ cắt ở dấu ĐẦU TIÊN. */
export function splitFbId(fbId: string): { pageId: string; psid: string } | null {
    const i = fbId.indexOf("_");
    if (i <= 0 || i === fbId.length - 1) return null;
    return { pageId: fbId.slice(0, i), psid: fbId.slice(i + 1) };
}

function toPosCustomer(raw: RawPosCustomer): PosCustomer | null {
    if (!raw.fb_id) return null;
    const split = splitFbId(String(raw.fb_id));
    if (!split) return null;

    const updatedRaw = raw.updated_at ?? raw.inserted_at;
    const updatedMs = updatedRaw ? Date.parse(updatedRaw) : NaN;

    return {
        pageId: split.pageId,
        psid: split.psid,
        name: raw.name ?? null,
        phone: raw.phone_numbers?.[0] ?? null,
        orderCount: Number(raw.order_count) || 0,
        updatedAt: Number.isFinite(updatedMs) ? new Date(updatedMs) : null,
    };
}

export interface FetchResult {
    customers: PosCustomer[];
    pagesFetched: number;
    hitCap: boolean;
}

/**
 * Lấy toàn bộ khách của một shop POS, phân trang tới hết.
 *
 * Ràng buộc quan trọng: POS trả khách của MỌI page thuộc shop, nên phải lọc
 * theo pageId ở phía mình. Dừng khi một trang trả về toàn khách đã thấy
 * (POS có lúc trả trùng thay vì trả rỗng ở trang cuối).
 */
export async function fetchCustomers(
    shop: PosShop,
    opts: { pageSize?: number; maxPages?: number; onProgress?: (found: number, page: number) => void } = {}
): Promise<FetchResult> {
    const pageSize = opts.pageSize ?? 50;
    const maxPages = opts.maxPages ?? 200;

    const byKey = new Map<string, PosCustomer>();
    let pagesFetched = 0;
    let hitCap = false;

    for (let page = 1; page <= maxPages; page++) {
        pagesFetched = page;
        const url = `${API_URL}/shops/${shop.shop_id}/customers?api_key=${shop.api_key}&page=${page}&page_size=${pageSize}`;

        let data: { data?: RawPosCustomer[] } | null = null;
        try {
            data = await fetchJson<{ data?: RawPosCustomer[] }>(url, { label: "pos.customers", timeoutMs: 30_000, retries: 2 });
        } catch (err) {
            log.warn({ shop: shop.name, page, err: err instanceof Error ? err.message : String(err) }, "POS trả lỗi — dừng phân trang");
            break;
        }

        const batch = data?.data ?? [];
        if (batch.length === 0) break;

        let added = 0;
        for (const raw of batch) {
            const c = toPosCustomer(raw);
            if (!c) continue;
            const key = `${c.pageId}_${c.psid}`;
            const prev = byKey.get(key);
            // Cùng khách xuất hiện nhiều lần → giữ bản có số đơn cao nhất
            if (!prev || c.orderCount > prev.orderCount) {
                byKey.set(key, c);
                if (!prev) added++;
            }
        }

        opts.onProgress?.(byKey.size, page);

        if (added === 0) break;              // toàn trùng → đã hết dữ liệu mới
        if (batch.length < pageSize) break;  // trang cuối
        if (page === maxPages) hitCap = true;
    }

    return { customers: [...byKey.values()], pagesFetched, hitCap };
}

/** Kiểm tra khoá POS còn dùng được không — cho npm run check:tokens. */
export async function ping(shop: PosShop): Promise<{ ok: boolean; sample: number; error?: string }> {
    try {
        const url = `${API_URL}/shops/${shop.shop_id}/customers?api_key=${shop.api_key}&page=1&page_size=1`;
        const data = await fetchJson<{ data?: RawPosCustomer[] }>(url, { label: "pos.ping", timeoutMs: 15_000, retries: 1 });
        return { ok: Array.isArray(data?.data), sample: data?.data?.length ?? 0 };
    } catch (err) {
        return { ok: false, sample: 0, error: err instanceof Error ? err.message : String(err) };
    }
}

/** Chỉ dùng trong test — xoá cache để nạp lại file cấu hình. */
export function resetCache(): void {
    shopsCache = null;
}
