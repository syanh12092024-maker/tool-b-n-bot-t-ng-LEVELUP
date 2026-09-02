import { config } from "../config/index.js";
import { logger } from "../lib/logger.js";
import { fetchJson, tryFetchJson, maskUrl } from "../lib/http.js";
import { sleep, DAY_MS } from "../lib/time.js";
import type { SyncedCustomer, SendErrorKind } from "../domain/types.js";

/**
 * Client Pancake — đường lấy khách và đường gửi tin CHÍNH.
 *
 * Phần quét hội thoại kế thừa cách đã kiểm chứng ở bản v1: endpoint v1 chặn
 * cứng ở 500 hội thoại, nên phải đi qua public_api và lùi theo từng cửa sổ
 * 28 ngày. Khác biệt: ở đây chạy trong job nền nên không có ai ngồi chờ, và
 * kết quả ghi thẳng xuống database thay vì giữ trong RAM.
 */

const log = logger.child({ client: "pancake" });

const WINDOW_DAYS = 28; // public_api yêu cầu since..until dưới 1 tháng
const PAGE_SIZE = 200;
const MAX_EMPTY_WINDOWS = 3;
const REQ_DELAY_MS = 120;

// ─── Token của từng page ──────────────────────────────────────────────────────
// Endpoint generate_page_access_token của Pancake hay trả "Server internal error",
// trong khi mỗi page trong /pages đã kèm sẵn settings.page_access_token dùng được.
// Nên: lấy từ danh sách trước, chỉ gọi generate khi không có.

interface PancakePage {
    id: string;
    name: string;
    token: string | null;
}

let pageCache: { pages: Map<string, PancakePage>; expiresAt: number } = {
    pages: new Map(),
    expiresAt: 0,
};

const PAGE_CACHE_MS = 5 * 60 * 1000;

async function loadPages(force = false): Promise<Map<string, PancakePage>> {
    if (!force && pageCache.expiresAt > Date.now() && pageCache.pages.size > 0) {
        return pageCache.pages;
    }

    const url = `${config.pancake.apiUrl}/pages?access_token=${config.pancake.token}&version=v1`;
    const data = await fetchJson<{
        categorized?: Record<string, Array<{ id?: string; name?: string; settings?: { page_access_token?: string } }>>;
    }>(url, { label: "pancake.pages", timeoutMs: 20_000 });

    const cat = data.categorized ?? {};
    const all = [...(cat.activated ?? []), ...(cat.hidden ?? []), ...(cat.suspended ?? []), ...(cat.not_activated ?? [])];

    const pages = new Map<string, PancakePage>();
    for (const p of all) {
        if (!p.id) continue;
        pages.set(String(p.id), {
            id: String(p.id),
            name: p.name ?? `Page ${p.id}`,
            token: p.settings?.page_access_token ?? null,
        });
    }

    if (pages.size > 0) {
        pageCache = { pages, expiresAt: Date.now() + PAGE_CACHE_MS };
        log.info({ count: pages.size }, "Đã nạp danh sách page từ Pancake");
    }
    return pages;
}

/** Danh sách page mà token CRM hiện tại nhìn thấy. */
export async function listPages(): Promise<Array<{ pageId: string; name: string; hasToken: boolean }>> {
    const pages = await loadPages(true);
    return [...pages.values()]
        .map((p) => ({ pageId: p.id, name: p.name, hasToken: p.token !== null }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

/** Token của một page. forceRefresh dùng khi token cũ vừa trả lỗi 105. */
export async function getPageToken(pageId: string, forceRefresh = false): Promise<string | null> {
    if (forceRefresh) {
        pageCache.pages.delete(pageId);
        pageCache.expiresAt = 0;
    }

    const pages = await loadPages(forceRefresh);
    const direct = pages.get(pageId)?.token;
    if (direct) return direct;

    // Dự phòng: gọi endpoint generate (hay lỗi phía Pancake, nhưng đôi khi chạy)
    const url = `${config.pancake.apiUrl}/pages/${pageId}/generate_page_access_token?access_token=${config.pancake.token}`;
    const data = await tryFetchJson<{ success?: boolean; page_access_token?: string }>(url, {
        method: "POST",
        label: "pancake.generateToken",
        retries: 1,
    });

    if (data?.success && data.page_access_token) return data.page_access_token;

    log.warn({ pageId }, "Không lấy được page token");
    return null;
}

// ─── Quét hội thoại ───────────────────────────────────────────────────────────

interface RawConversation {
    id?: string;
    from?: { id?: string; name?: string };
    from_psid?: string | number;
    customers?: Array<{ id?: string; name?: string }>;
    recent_phone_numbers?: Array<string | { phone_number?: string; captured?: string }>;
    has_phone?: boolean;
    tags?: Array<number | string | { id?: number; text?: string; name?: string }>;
    page_id?: string | number;
    updated_at?: string;
    inserted_at?: string;
    last_customer_interactive_at?: string;
}

function extractPhone(c: RawConversation): string | null {
    const arr = c.recent_phone_numbers ?? [];
    const first = arr[0];
    if (typeof first === "string" && first) return first;
    if (first && typeof first === "object") return first.phone_number ?? first.captured ?? null;
    return null;
}

function extractTags(c: RawConversation): string[] {
    return (c.tags ?? []).map((t) => (t && typeof t === "object" ? String(t.text ?? t.name ?? t.id ?? "") : String(t))).filter(Boolean);
}

function toSyncedCustomer(c: RawConversation): SyncedCustomer | null {
    const psid = String(c.from_psid ?? c.from?.id ?? "");
    if (!psid) return null;

    const lastRaw = c.last_customer_interactive_at ?? c.updated_at ?? c.inserted_at;
    const lastMs = lastRaw ? Date.parse(lastRaw) : NaN;
    if (!Number.isFinite(lastMs)) return null; // không biết mốc tương tác thì không tính được cửa sổ

    return {
        psid,
        conversationId: c.id ? String(c.id) : null,
        name: c.from?.name ?? c.customers?.[0]?.name ?? null,
        phone: extractPhone(c),
        orderCount: 0, // POS bổ sung sau, nếu page có shop
        tags: extractTags(c),
        lastInteractionAt: new Date(lastMs),
    };
}

export interface ScanResult {
    customers: SyncedCustomer[];
    windowsScanned: number;
    hitCap: boolean;
}

/**
 * Quét toàn bộ hội thoại của một page, lùi ngược thời gian theo từng cửa sổ 28 ngày.
 * Dừng sớm khi 3 cửa sổ liên tiếp không ra bản ghi mới.
 */
export async function scanConversations(
    pageId: string,
    opts: { maxWindows?: number; maxCustomers?: number; concurrency?: number; onProgress?: (found: number, window: number) => void } = {}
): Promise<ScanResult> {
    const maxWindows = opts.maxWindows ?? config.sync.maxWindows;
    const maxCustomers = opts.maxCustomers ?? config.sync.maxCustomersPerPage;
    const concurrency = opts.concurrency ?? config.sync.pageConcurrency;

    const token = await getPageToken(pageId);
    if (!token) throw new Error(`Không lấy được page token cho page ${pageId}`);

    const byPsid = new Map<string, SyncedCustomer>();
    let until = Math.floor(Date.now() / 1000);
    let emptyStreak = 0;
    let windowsScanned = 0;
    let hitCap = false;

    for (let w = 0; w < maxWindows && !hitCap; w++) {
        windowsScanned = w + 1;
        const since = until - (WINDOW_DAYS * DAY_MS) / 1000;
        let newInWindow = 0;
        let exhausted = false;

        for (let pn = 1; pn <= 500 && !exhausted && !hitCap; pn += concurrency) {
            const pageNumbers = Array.from({ length: concurrency }, (_, k) => pn + k);
            const responses = await Promise.all(
                pageNumbers.map((n) =>
                    tryFetchJson<{ conversations?: RawConversation[]; data?: RawConversation[] }>(
                        `${config.pancake.publicApiUrl}/pages/${pageId}/conversations` +
                            `?page_access_token=${token}&since=${since}&until=${until}&page_number=${n}`,
                        { label: "pancake.conversations", timeoutMs: 20_000, retries: 3 }
                    )
                )
            );

            for (const res of responses) {
                const convs = res?.conversations ?? res?.data ?? [];
                if (convs.length === 0) {
                    exhausted = true;
                    continue;
                }
                for (const raw of convs) {
                    // public_api đôi khi trả lẫn hội thoại của page khác
                    if (raw.page_id !== undefined && String(raw.page_id) !== pageId) continue;
                    const cust = toSyncedCustomer(raw);
                    if (!cust || byPsid.has(cust.psid)) continue;
                    byPsid.set(cust.psid, cust);
                    newInWindow++;
                }
                if (convs.length < PAGE_SIZE) exhausted = true;
            }

            if (byPsid.size >= maxCustomers) hitCap = true;
            if (!exhausted && !hitCap) await sleep(REQ_DELAY_MS);
        }

        opts.onProgress?.(byPsid.size, windowsScanned);

        emptyStreak = newInWindow === 0 ? emptyStreak + 1 : 0;
        if (emptyStreak >= MAX_EMPTY_WINDOWS) break;

        until = since;
        await sleep(REQ_DELAY_MS);
    }

    return { customers: [...byPsid.values()], windowsScanned, hitCap };
}

// ─── Gửi tin ──────────────────────────────────────────────────────────────────

export interface PancakeSendResult {
    success: boolean;
    errorKind?: SendErrorKind;
    errorCode?: string;
    errorMessage?: string;
}

/** Đọc mã lỗi Pancake và quy về một loại mà hệ thống biết cách phản ứng. */
export function classifyPancakeError(code: unknown, message: string): SendErrorKind {
    const c = String(code ?? "");
    const m = message.toLowerCase();

    if (c === "121" || m.includes("gói cước") || m.includes("goi cuoc")) return "PAGE_QUOTA";
    if (c === "2022" || m.includes("#2022") || m.includes("(2022)")) return "PAGE_BLOCKED";
    if (c === "105") return "TOKEN_EXPIRED";
    if (c === "190" || m.includes("(#190)")) return "TOKEN_EXPIRED";
    if (c === "613" || m.includes("(#613)") || m.includes("rate limit")) return "RATE_LIMITED";
    if (c === "551" || m.includes("(#551)") || m.includes("không có mặt") || m.includes("not available")) {
        return "USER_UNAVAILABLE";
    }
    if (
        c === "10" ||
        m.includes("(#10)") ||
        m.includes("outside") ||
        m.includes("ngoài khoảng") ||
        m.includes("24-hour") ||
        m.includes("24h")
    ) {
        return "OUT_OF_WINDOW";
    }
    return "UNKNOWN";
}

/** Gửi một tin text vào đúng luồng hội thoại. */
export async function sendText(
    pageId: string,
    conversationId: string,
    text: string,
    pageToken: string
): Promise<PancakeSendResult> {
    const url =
        `${config.pancake.publicApiUrl}/pages/${pageId}/conversations/${conversationId}/messages` +
        `?page_access_token=${pageToken}`;

    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "reply_inbox", message: text }),
            signal: AbortSignal.timeout(30_000),
        });

        const raw = await res.text();
        let data: Record<string, unknown> = {};
        try {
            data = JSON.parse(raw) as Record<string, unknown>;
        } catch {
            data = { message: raw.slice(0, 200) };
        }

        if (data.success === true) return { success: true };

        const code = data.error_code ?? data.code ?? "";
        const message = String(data.original_error ?? data.message ?? data.error ?? `HTTP ${res.status}`);
        return {
            success: false,
            errorKind: classifyPancakeError(code, message),
            errorCode: String(code || res.status),
            errorMessage: message.slice(0, 300),
        };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, errorKind: "NETWORK", errorMessage: message.slice(0, 300) };
    }
}

/** Tải ảnh lên Pancake, trả về content id để đính vào tin. */
export async function uploadImage(
    pageId: string,
    file: { buffer: Buffer; name: string; type: string },
    pageToken: string
): Promise<{ contentId: string } | PancakeSendResult> {
    const url = `${config.pancake.publicApiUrl}/pages/${pageId}/upload_contents?page_access_token=${pageToken}`;
    try {
        const fd = new FormData();
        fd.append("file", new Blob([new Uint8Array(file.buffer)], { type: file.type }), file.name);

        const res = await fetch(url, { method: "POST", body: fd, signal: AbortSignal.timeout(45_000) });
        const data = (await res.json().catch(() => ({}))) as Record<string, any>;

        const contentId = data?.id ?? data?.content_id ?? data?.data?.id ?? data?.data?.content_id;
        if (contentId) return { contentId: String(contentId) };

        const code = data?.error_code ?? data?.code ?? "";
        const message = String(data?.message ?? "upload_contents không trả content_id");
        return { success: false, errorKind: classifyPancakeError(code, message), errorCode: String(code), errorMessage: message };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, errorKind: "NETWORK", errorMessage: message.slice(0, 300) };
    }
}

/** Gửi ảnh đã tải lên trước đó. */
export async function sendImages(
    pageId: string,
    conversationId: string,
    contentIds: string[],
    pageToken: string
): Promise<PancakeSendResult> {
    const url =
        `${config.pancake.publicApiUrl}/pages/${pageId}/conversations/${conversationId}/messages` +
        `?page_access_token=${pageToken}`;
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "reply_inbox", content_ids: contentIds }),
            signal: AbortSignal.timeout(30_000),
        });
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (data.success === true) return { success: true };

        const code = data.error_code ?? data.code ?? "";
        const message = String(data.original_error ?? data.message ?? `HTTP ${res.status}`);
        return {
            success: false,
            errorKind: classifyPancakeError(code, message),
            errorCode: String(code || res.status),
            errorMessage: message.slice(0, 300),
        };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, errorKind: "NETWORK", errorMessage: message.slice(0, 300) };
    }
}

/** Kiểm tra token CRM còn sống không — dùng cho npm run check:tokens. */
export async function ping(): Promise<{ ok: boolean; pageCount: number; error?: string }> {
    try {
        const pages = await loadPages(true);
        return { ok: pages.size > 0, pageCount: pages.size };
    } catch (err) {
        return { ok: false, pageCount: 0, error: err instanceof Error ? err.message : String(err) };
    }
}

export { maskUrl };
