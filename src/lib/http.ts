import { sleep } from "./time.js";
import { logger } from "./logger.js";

/**
 * Gọi HTTP có timeout và thử lại.
 *
 * Bài học từ bản v1: một request treo là treo cả job. Ở đây MỌI request đều
 * có timeout cứng, và chỉ thử lại với lỗi tạm thời (mạng, 429, 5xx) — lỗi
 * 4xx thì thử lại chỉ tốn hạn mức API.
 */

export interface FetchOpts extends RequestInit {
    timeoutMs?: number;
    retries?: number;
    /** Nhãn ngắn để đọc log, ví dụ "pancake.conversations" */
    label?: string;
}

const DEFAULT_TIMEOUT = 20_000;
const DEFAULT_RETRIES = 2;

export class HttpError extends Error {
    constructor(
        override readonly message: string,
        readonly status: number,
        readonly body: string
    ) {
        super(message);
        this.name = "HttpError";
    }
}

/** Che token trong URL trước khi ghi log. */
export function maskUrl(url: string): string {
    return url.replace(/((?:access_token|page_access_token|api_key)=)[^&]+/gi, "$1***");
}

export async function fetchJson<T = unknown>(url: string, opts: FetchOpts = {}): Promise<T> {
    const { timeoutMs = DEFAULT_TIMEOUT, retries = DEFAULT_RETRIES, label, ...init } = opts;

    let lastErr: unknown;

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });

            // 429 / 5xx là lỗi tạm thời — nghỉ rồi thử lại
            if (res.status === 429 || res.status >= 500) {
                const body = await res.text().catch(() => "");
                lastErr = new HttpError(`HTTP ${res.status}`, res.status, body.slice(0, 300));
                if (attempt < retries) {
                    const waitMs = res.status === 429 ? 1000 * (attempt + 1) : 400 * (attempt + 1);
                    logger.debug({ label, status: res.status, waitMs, url: maskUrl(url) }, "Thử lại");
                    await sleep(waitMs);
                    continue;
                }
                throw lastErr;
            }

            const text = await res.text();
            if (!res.ok) {
                // 4xx: thử lại vô ích, ném luôn
                throw new HttpError(`HTTP ${res.status}`, res.status, text.slice(0, 300));
            }

            try {
                return JSON.parse(text) as T;
            } catch {
                throw new HttpError("Phản hồi không phải JSON", res.status, text.slice(0, 300));
            }
        } catch (err) {
            if (err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 429) {
                throw err; // lỗi phía mình, không thử lại
            }
            lastErr = err;
            if (attempt < retries) {
                await sleep(400 * (attempt + 1));
                continue;
            }
        }
    }

    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    logger.warn({ label, url: maskUrl(url), err: msg }, "Gọi HTTP thất bại sau khi đã thử lại");
    throw lastErr instanceof Error ? lastErr : new Error(msg);
}

/** Như fetchJson nhưng trả null thay vì ném lỗi — dùng cho đường có sẵn phương án dự phòng. */
export async function tryFetchJson<T = unknown>(url: string, opts: FetchOpts = {}): Promise<T | null> {
    try {
        return await fetchJson<T>(url, opts);
    } catch {
        return null;
    }
}

/** Chạy các tác vụ theo lô song song, giữ nguyên thứ tự kết quả. */
export async function mapConcurrent<T, R>(
    items: readonly T[],
    concurrency: number,
    fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let cursor = 0;

    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        for (;;) {
            const i = cursor++;
            if (i >= items.length) return;
            results[i] = await fn(items[i] as T, i);
        }
    });

    await Promise.all(workers);
    return results;
}
