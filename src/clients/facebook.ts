import { config } from "../config/index.js";
import { logger } from "../lib/logger.js";
import { fetchJson } from "../lib/http.js";
import type { SendErrorKind } from "../domain/types.js";

/**
 * Client Facebook Graph API — đường gửi DỰ PHÒNG khi Pancake từ chối.
 *
 * Gửi chủ động ngoài cửa sổ 24h bắt buộc phải kèm message tag. App có thể
 * chưa được duyệt một tag nào đó (lỗi #100/#200), nên thử lần lượt theo thang:
 *   HUMAN_AGENT (cửa sổ 7 ngày) → POST_PURCHASE_UPDATE → ACCOUNT_UPDATE → RESPONSE
 * Tag nào đi được thì dừng và ghi lại để báo cáo.
 */

const log = logger.child({ client: "facebook" });

const graph = () => `https://graph.facebook.com/${config.facebook.graphVersion}`;

// ─── Token của từng page ──────────────────────────────────────────────────────
// Page id bên Pancake TRÙNG với page id bên Facebook (đều là id Fanpage), nhưng
// token thì khác hẳn — token Pancake dùng với Graph API là lỗi #190 ngay.

const cache: { byId: Map<string, string>; byName: Map<string, string>; expiresAt: number } = {
    byId: new Map(),
    byName: new Map(),
    expiresAt: 0,
};

async function loadPages(): Promise<void> {
    if (cache.expiresAt > Date.now()) return;
    if (!config.facebook.enabled) return;

    cache.byId.clear();
    cache.byName.clear();

    let url: string =
        `${graph()}/me/accounts?access_token=${config.facebook.userToken}&limit=100&fields=id,name,access_token`;
    let count = 0;

    try {
        while (url) {
            const data = await fetchJson<{
                data?: Array<{ id: string; name?: string; access_token?: string }>;
                paging?: { next?: string };
                error?: { message?: string };
            }>(url, { label: "facebook.accounts" });

            if (data.error) {
                log.error({ err: data.error.message }, "Graph API /me/accounts trả lỗi");
                break;
            }
            for (const p of data.data ?? []) {
                if (!p.access_token) continue;
                cache.byId.set(String(p.id), p.access_token);
                if (p.name) cache.byName.set(p.name.toLowerCase().trim(), p.access_token);
                count++;
            }
            url = data.paging?.next ?? "";
        }
    } catch (err) {
        log.error({ err: err instanceof Error ? err.message : String(err) }, "Không nạp được danh sách page Facebook");
    }

    // Có kết quả thì nhớ 1 giờ; rỗng (token hỏng?) thì chỉ 1 phút để sớm thử lại
    cache.expiresAt = Date.now() + (count > 0 ? 3_600_000 : 60_000);
    log.info({ count }, "Đã nạp page token từ Facebook");
}

/**
 * Token của đúng page này. Chỉ khớp theo ID hoặc tên trùng khít — TUYỆT ĐỐI không
 * mượn token của page khác: bản v1 từng gửi tin từ nhầm page vì lỗi này.
 */
export async function getPageToken(pageId: string, pageName?: string): Promise<string | null> {
    if (!config.facebook.enabled) return null;
    await loadPages();

    const byId = cache.byId.get(pageId);
    if (byId) return byId;

    if (pageName) {
        const byName = cache.byName.get(pageName.toLowerCase().trim());
        if (byName) return byName;
    }

    // Cơ hội cuối: hỏi thẳng Graph API bằng đúng page id
    try {
        const data = await fetchJson<{ access_token?: string }>(
            `${graph()}/${pageId}?fields=access_token&access_token=${config.facebook.userToken}`,
            { label: "facebook.pageToken", retries: 0 }
        );
        if (data.access_token) return data.access_token;
    } catch {
        /* rơi xuống null */
    }

    log.warn({ pageId, pageName }, "Không có token Facebook cho page này — không dùng token page khác");
    return null;
}

// ─── Phân loại lỗi ────────────────────────────────────────────────────────────

export function classifyFacebookError(code: unknown, subcode: unknown, message: string): SendErrorKind {
    const c = String(code ?? "");
    const m = message.toLowerCase();

    if (c === "2022" || m.includes("#2022")) return "PAGE_BLOCKED";
    if (c === "190") return "TOKEN_EXPIRED";
    if (c === "613" || c === "4" || c === "17" || c === "32") return "RATE_LIMITED";
    if (c === "551") return "USER_UNAVAILABLE";
    if (c === "10") return "OUT_OF_WINDOW";
    if (c === "100" && (m.includes("no matching user") || m.includes("invalid"))) return "INVALID_RECIPIENT";
    if (c === "100" || c === "200") return "UNKNOWN"; // thường là chưa được duyệt tag → thang tag sẽ xử lý
    return "UNKNOWN";
}

/** Mã lỗi nào cho phép thử tag tiếp theo, mã nào phải dừng hẳn. */
function shouldTryNextTag(code: string): boolean {
    // #100/#200 = tag chưa được duyệt · #10 = ngoài cửa sổ của tag này · #190 = token sai
    return code === "100" || code === "200" || code === "10" || code === "190";
}

// ─── Gửi ──────────────────────────────────────────────────────────────────────

export interface FacebookSendResult {
    success: boolean;
    messageId?: string;
    tagUsed?: string;
    errorKind?: SendErrorKind;
    errorCode?: string;
    errorMessage?: string;
}

const TAG_LADDER: Array<{ messaging_type: string; tag?: string }> = [
    { messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" },
    { messaging_type: "MESSAGE_TAG", tag: "POST_PURCHASE_UPDATE" },
    { messaging_type: "MESSAGE_TAG", tag: "ACCOUNT_UPDATE" },
    { messaging_type: "RESPONSE" },
];

interface GraphSendResponse {
    recipient_id?: string;
    message_id?: string;
    error?: { code?: number | string; error_subcode?: number | string; message?: string };
}

async function postMessage(pageToken: string, body: Record<string, unknown>): Promise<GraphSendResponse> {
    const res = await fetch(`${graph()}/me/messages?access_token=${pageToken}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
    });
    return (await res.json().catch(() => ({}))) as GraphSendResponse;
}

/** Gửi một nội dung (text hoặc attachment) đi qua thang tag. */
async function sendWithLadder(
    psid: string,
    message: Record<string, unknown>,
    pageToken: string
): Promise<FacebookSendResult> {
    const errors: string[] = [];

    for (const step of TAG_LADDER) {
        const label = step.tag ?? step.messaging_type;
        try {
            const body: Record<string, unknown> = {
                recipient: { id: psid },
                message,
                messaging_type: step.messaging_type,
            };
            if (step.tag) body.tag = step.tag;

            const data = await postMessage(pageToken, body);

            if (data.error) {
                const code = String(data.error.code ?? "");
                const msg = data.error.message ?? JSON.stringify(data.error);
                errors.push(`${label}[#${code}] ${msg.slice(0, 80)}`);

                if (shouldTryNextTag(code)) continue;

                // Lỗi không thể cứu bằng đổi tag → dừng và báo đúng loại
                return {
                    success: false,
                    errorKind: classifyFacebookError(code, data.error.error_subcode, msg),
                    errorCode: code,
                    errorMessage: errors.join(" | ").slice(0, 300),
                };
            }

            if (data.message_id) {
                return { success: true, messageId: data.message_id, tagUsed: label };
            }
            errors.push(`${label}: phản hồi lạ ${JSON.stringify(data).slice(0, 60)}`);
        } catch (err) {
            errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 80));
        }
    }

    // Đi hết thang mà không tag nào chạy → gần như chắc chắn ngoài cửa sổ
    return {
        success: false,
        errorKind: "OUT_OF_WINDOW",
        errorCode: "TAGS_EXHAUSTED",
        errorMessage: errors.join(" | ").slice(0, 300),
    };
}

export function sendText(psid: string, text: string, pageToken: string): Promise<FacebookSendResult> {
    return sendWithLadder(psid, { text }, pageToken);
}

/** Gửi ảnh qua URL công khai mà Facebook tải được. */
export function sendImageUrl(psid: string, imageUrl: string, pageToken: string): Promise<FacebookSendResult> {
    return sendWithLadder(
        psid,
        { attachment: { type: "image", payload: { url: imageUrl, is_reusable: true } } },
        pageToken
    );
}

/** PSID hợp lệ là chuỗi số dài — id nội bộ của Pancake không gửi qua Graph API được. */
export function isValidPsid(psid: string): boolean {
    return /^\d{10,}$/.test(psid);
}

/** Kiểm tra token user Facebook còn sống không — dùng cho npm run check:tokens. */
export async function ping(): Promise<{ ok: boolean; pageCount: number; error?: string; enabled: boolean }> {
    if (!config.facebook.enabled) return { ok: false, pageCount: 0, enabled: false, error: "Chưa đặt FB_USER_ACCESS_TOKEN" };
    cache.expiresAt = 0;
    await loadPages();
    return { ok: cache.byId.size > 0, pageCount: cache.byId.size, enabled: true };
}
