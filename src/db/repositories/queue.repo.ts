import { query, queryOne } from "../pool.js";
import type { QueueJob, SendableJob, SendOutcome, QueueState } from "../../domain/types.js";

/**
 * Hàng đợi gửi + nhật ký gửi.
 *
 * Toàn bộ chống-trùng nằm ở đây, ở tầng database:
 *   - UNIQUE (customer_id, journey_day, slot_index) chặn xếp hai lần cùng một lượt
 *   - FOR UPDATE SKIP LOCKED chặn hai worker cùng lấy một job
 */

export interface EnqueueRow {
    customerId: number;
    pageDbId: number;
    scriptMessageId: number;
    journeyDay: number;
    slotIndex: number;
    scheduledAt: Date;
}

/** Xếp một lô vào hàng đợi. Lượt nào đã có (trùng khoá) thì bỏ qua lặng lẽ. */
export async function enqueueBatch(rows: EnqueueRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    const inserted = await query<{ id: number }>(
        `INSERT INTO send_queue (customer_id, page_id, script_message_id, journey_day, slot_index, scheduled_at)
         SELECT * FROM unnest($1::bigint[], $2::bigint[], $3::bigint[], $4::smallint[], $5::smallint[], $6::timestamptz[])
         ON CONFLICT (customer_id, journey_day, slot_index) DO NOTHING
         RETURNING id`,
        [
            rows.map((r) => r.customerId),
            rows.map((r) => r.pageDbId),
            rows.map((r) => r.scriptMessageId),
            rows.map((r) => r.journeyDay),
            rows.map((r) => r.slotIndex),
            rows.map((r) => r.scheduledAt.toISOString()),
        ]
    );
    return inserted.length;
}

/**
 * Lấy một lô job tới hạn và khoá chúng cho worker này.
 *
 * Điều kiện lấy: tới giờ · page đang bật và không bị ngưng · khách vẫn active.
 * Trả về đủ dữ liệu để gửi ngay, không cần truy vấn thêm.
 */
export function pickBatch(limit: number, workerId: string, pageDbId?: number): Promise<SendableJob[]> {
    return query<SendableJob>(
        `WITH picked AS (
            SELECT q.id
              FROM send_queue q
              JOIN pages     p ON p.id = q.page_id
              JOIN customers c ON c.id = q.customer_id
             WHERE q.state = 'queued'
               AND q.scheduled_at <= now()
               AND p.is_active
               AND (p.health_state <> 'paused' OR (p.paused_until IS NOT NULL AND p.paused_until < now()))
               AND c.status = 'active'
               AND ($3::bigint IS NULL OR q.page_id = $3)
             ORDER BY q.scheduled_at
             LIMIT $1
             FOR UPDATE OF q SKIP LOCKED
         ),
         upd AS (
            UPDATE send_queue q
               SET state = 'sending', locked_at = now(), locked_by = $2, attempt_count = q.attempt_count + 1
              FROM picked
             WHERE q.id = picked.id
             RETURNING q.*
         )
         SELECT u.id, u.customer_id, u.page_id, u.script_message_id, u.journey_day, u.slot_index,
                u.scheduled_at, u.state, u.attempt_count,
                c.psid, c.conversation_id, c.name AS customer_name, c.last_interaction_at,
                p.page_id AS fb_page_id, p.page_name,
                m.body, m.media
           FROM upd u
           JOIN customers       c ON c.id = u.customer_id
           JOIN pages           p ON p.id = u.page_id
           JOIN script_messages m ON m.id = u.script_message_id
          ORDER BY u.scheduled_at`,
        [limit, workerId, pageDbId ?? null]
    );
}

export async function markSent(id: number): Promise<void> {
    await query(`UPDATE send_queue SET state = 'sent', locked_at = NULL, locked_by = NULL WHERE id = $1`, [id]);
}

/** Thất bại. retry=true → trả về hàng đợi để thử lại; false → chốt failed. */
export async function markFailed(id: number, error: string, retry: boolean): Promise<void> {
    await query(
        `UPDATE send_queue
            SET state = $3::queue_state, last_error = $2, locked_at = NULL, locked_by = NULL
          WHERE id = $1`,
        [id, error.slice(0, 500), retry ? "queued" : "failed"]
    );
}

export async function markSkipped(id: number, reason: string): Promise<void> {
    await query(
        `UPDATE send_queue SET state = 'skipped', last_error = $2, locked_at = NULL, locked_by = NULL WHERE id = $1`,
        [id, reason.slice(0, 500)]
    );
}

/** Job trễ quá cửa sổ cho phép → bỏ, không gửi bù (tin buổi sáng gửi chiều là phản tác dụng). */
export async function skipLate(lateWindowMin: number): Promise<number> {
    const rows = await query<{ id: number }>(
        `UPDATE send_queue
            SET state = 'skipped', last_error = 'Quá giờ hẹn ' || $1 || ' phút — không gửi bù'
          WHERE state = 'queued' AND scheduled_at < now() - make_interval(mins => $1)
          RETURNING id`,
        [lateWindowMin]
    );
    return rows.length;
}

/** Worker chết giữa chừng để lại job kẹt 'sending' → trả về hàng đợi. */
export async function releaseStuck(stuckMinutes: number): Promise<number> {
    const rows = await query<{ id: number }>(
        `UPDATE send_queue
            SET state = 'queued', locked_at = NULL, locked_by = NULL,
                last_error = 'Worker không phản hồi, đã gỡ khoá'
          WHERE state = 'sending' AND locked_at < now() - make_interval(mins => $1)
          RETURNING id`,
        [stuckMinutes]
    );
    return rows.length;
}

/** Khách vừa chốt/từ chối → huỷ mọi lượt còn chờ của khách đó. */
export async function cancelPendingForCustomer(customerId: number, reason: string): Promise<number> {
    const rows = await query<{ id: number }>(
        `UPDATE send_queue SET state = 'skipped', last_error = $2
          WHERE customer_id = $1 AND state = 'queued'
          RETURNING id`,
        [customerId, reason.slice(0, 500)]
    );
    return rows.length;
}

/** Page vừa bị ngưng → mọi job đang chờ của page giữ nguyên, chỉ cần không lấy ra. Hàm này để thống kê. */
export async function countByState(pageDbId?: number): Promise<Record<QueueState, number>> {
    const rows = await query<{ state: QueueState; n: number }>(
        `SELECT state, COUNT(*)::int AS n FROM send_queue
          WHERE ($1::bigint IS NULL OR page_id = $1) GROUP BY state`,
        [pageDbId ?? null]
    );
    const out: Record<QueueState, number> = { queued: 0, sending: 0, sent: 0, failed: 0, skipped: 0 };
    for (const r of rows) out[r.state] = r.n;
    return out;
}

/** Số lượt đã xếp hôm nay cho một page (theo scheduled_at trong ngày UTC hiện tại của page). */
export async function countQueuedToday(pageDbId: number, dayStartUtc: Date, dayEndUtc: Date): Promise<number> {
    const row = await queryOne<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM send_queue
          WHERE page_id = $1 AND scheduled_at >= $2 AND scheduled_at < $3`,
        [pageDbId, dayStartUtc.toISOString(), dayEndUtc.toISOString()]
    );
    return row?.n ?? 0;
}

// ─── Nhật ký ──────────────────────────────────────────────────────────────────

export async function writeLog(job: QueueJob, outcome: SendOutcome): Promise<void> {
    await query(
        `INSERT INTO send_log
            (queue_id, customer_id, page_id, script_message_id, journey_day, slot_index,
             channel, fb_tag, success, error_kind, error_code, error_message, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
            job.id,
            job.customer_id,
            job.page_id,
            job.script_message_id,
            job.journey_day,
            job.slot_index,
            outcome.channel,
            outcome.fbTag ?? null,
            outcome.success,
            outcome.errorKind ?? null,
            outcome.errorCode ?? null,
            outcome.errorMessage ? outcome.errorMessage.slice(0, 500) : null,
            outcome.durationMs,
        ]
    );
}

/** Truy vết: một khách đã nhận gì, lúc nào, qua kênh nào. */
export function historyForCustomer(customerId: number, limit = 50) {
    return query<{
        sent_at: Date;
        journey_day: number | null;
        slot_index: number | null;
        channel: string;
        fb_tag: string | null;
        success: boolean;
        error_kind: string | null;
        error_message: string | null;
        body: string | null;
    }>(
        `SELECT l.sent_at, l.journey_day, l.slot_index, l.channel, l.fb_tag, l.success,
                l.error_kind, l.error_message, m.body
           FROM send_log l
           LEFT JOIN script_messages m ON m.id = l.script_message_id
          WHERE l.customer_id = $1
          ORDER BY l.sent_at DESC
          LIMIT $2`,
        [customerId, limit]
    );
}
