import { query, queryOne } from "../pool.js";
import type { Page } from "../../domain/types.js";

/** Thao tác với bảng pages. */

const COLS = `
    id, page_id, page_name, market, utc_offset, pancake_shop_id, is_active,
    health_state, paused_until, pause_reason, pause_count_24h,
    activated_at, ramp_percent, last_synced_at, last_planned_at
`;

export function listAll(): Promise<Page[]> {
    return query<Page>(`SELECT ${COLS} FROM pages ORDER BY market, page_name`);
}

export function listActive(): Promise<Page[]> {
    return query<Page>(`SELECT ${COLS} FROM pages WHERE is_active ORDER BY market, page_name`);
}

export function findById(id: number): Promise<Page | null> {
    return queryOne<Page>(`SELECT ${COLS} FROM pages WHERE id = $1`, [id]);
}

export function findByFbPageId(pageId: string): Promise<Page | null> {
    return queryOne<Page>(`SELECT ${COLS} FROM pages WHERE page_id = $1`, [pageId]);
}

export interface CreatePageInput {
    pageId: string;
    pageName: string;
    market: string;
    utcOffset: number;
    pancakeShopId?: string | null;
}

/** Thêm page; nếu page_id đã có thì cập nhật tên/thị trường/múi giờ. */
export async function upsert(input: CreatePageInput): Promise<Page> {
    const row = await queryOne<Page>(
        `INSERT INTO pages (page_id, page_name, market, utc_offset, pancake_shop_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (page_id) DO UPDATE SET
             page_name       = EXCLUDED.page_name,
             market          = EXCLUDED.market,
             utc_offset      = EXCLUDED.utc_offset,
             pancake_shop_id = COALESCE(EXCLUDED.pancake_shop_id, pages.pancake_shop_id)
         RETURNING ${COLS}`,
        [input.pageId, input.pageName, input.market, input.utcOffset, input.pancakeShopId ?? null]
    );
    if (!row) throw new Error("Upsert page không trả về dòng nào");
    return row;
}

/** Bật/tắt chiến dịch của page. Bật lần đầu thì ghi activated_at và bắt đầu khởi động dần. */
export async function setActive(id: number, active: boolean, rampStartPercent: number): Promise<void> {
    if (active) {
        await query(
            `UPDATE pages
                SET is_active    = TRUE,
                    activated_at = COALESCE(activated_at, now()),
                    ramp_percent = CASE WHEN activated_at IS NULL THEN $2 ELSE ramp_percent END
              WHERE id = $1`,
            [id, rampStartPercent]
        );
    } else {
        await query(`UPDATE pages SET is_active = FALSE WHERE id = $1`, [id]);
    }
}

export async function markSynced(id: number): Promise<void> {
    await query(`UPDATE pages SET last_synced_at = now() WHERE id = $1`, [id]);
}

export async function markPlanned(id: number): Promise<void> {
    await query(`UPDATE pages SET last_planned_at = now() WHERE id = $1`, [id]);
}

export async function setRampPercent(id: number, percent: number): Promise<void> {
    await query(`UPDATE pages SET ramp_percent = $2 WHERE id = $1`, [id, Math.max(0, Math.min(100, percent))]);
}

// ─── Sức khoẻ page ────────────────────────────────────────────────────────────

/** Tạm ngưng page. pause_count_24h tăng để tầng giám sát biết khi nào leo thang. */
export async function pause(id: number, minutes: number, reason: string): Promise<void> {
    await query(
        `UPDATE pages
            SET health_state    = 'paused',
                paused_until    = now() + make_interval(mins => $2),
                pause_reason    = $3,
                pause_count_24h = pause_count_24h + 1
          WHERE id = $1`,
        [id, minutes, reason]
    );
}

export async function degrade(id: number, reason: string): Promise<void> {
    await query(
        `UPDATE pages SET health_state = 'degraded', pause_reason = $2 WHERE id = $1 AND health_state <> 'paused'`,
        [id, reason]
    );
}

export async function recover(id: number): Promise<void> {
    await query(
        `UPDATE pages SET health_state = 'ok', paused_until = NULL, pause_reason = NULL WHERE id = $1`,
        [id]
    );
}

/** Page đã hết hạn ngưng → trả về 'degraded' để đi tiếp một cách thận trọng. */
export async function releaseExpiredPauses(): Promise<number[]> {
    const rows = await query<{ id: number }>(
        `UPDATE pages
            SET health_state = 'degraded', paused_until = NULL
          WHERE health_state = 'paused' AND paused_until IS NOT NULL AND paused_until < now()
          RETURNING id`
    );
    return rows.map((r) => r.id);
}

/** Reset bộ đếm ngưng mỗi 24h — gọi từ job health. */
export async function resetPauseCounters(): Promise<void> {
    await query(`UPDATE pages SET pause_count_24h = 0 WHERE pause_count_24h > 0`);
}

/** Page hiện có được gửi không (đang bật và không bị ngưng)? */
export function isSendable(p: Page, now: Date = new Date()): boolean {
    if (!p.is_active) return false;
    if (p.health_state !== "paused") return true;
    return p.paused_until !== null && p.paused_until.getTime() < now.getTime();
}
