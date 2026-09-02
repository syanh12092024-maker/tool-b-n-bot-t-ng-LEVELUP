import { query, queryOne } from "../pool.js";
import type { PageHealthState, CustomerStatus, QueueState } from "../../domain/types.js";

/**
 * Truy vấn tổng hợp cho dashboard.
 *
 * Tách riêng khỏi các repo nghiệp vụ vì đây là câu hỏi của NGƯỜI VẬN HÀNH
 * ("tin nào ra đơn nhiều nhất"), không phải của hệ thống. Các job không đụng
 * tới file này.
 */

// ─── Tổng quan ────────────────────────────────────────────────────────────────

export interface PageOverview {
    id: number;
    page_id: string;
    page_name: string;
    market: string;
    utc_offset: number;
    is_active: boolean;
    health_state: PageHealthState;
    paused_until: Date | null;
    pause_reason: string | null;
    ramp_percent: number;
    last_synced_at: Date | null;
    active: number;
    converted: number;
    opted_out: number;
    expired: number;
    queued_today: number;
    sent_today: number;
    failed_today: number;
    has_script: boolean;
}

export function overview(): Promise<PageOverview[]> {
    return query<PageOverview>(
        `SELECT p.id, p.page_id, p.page_name, p.market, p.utc_offset, p.is_active,
                p.health_state, p.paused_until, p.pause_reason, p.ramp_percent, p.last_synced_at,
                COALESCE(c.active, 0)      AS active,
                COALESCE(c.converted, 0)   AS converted,
                COALESCE(c.opted_out, 0)   AS opted_out,
                COALESCE(c.expired, 0)     AS expired,
                COALESCE(q.queued, 0)      AS queued_today,
                COALESCE(s.sent, 0)        AS sent_today,
                COALESCE(s.failed, 0)      AS failed_today,
                EXISTS (SELECT 1 FROM scripts sc WHERE sc.page_id = p.id AND sc.is_active) AS has_script
           FROM pages p
           LEFT JOIN LATERAL (
                SELECT COUNT(*) FILTER (WHERE status = 'active')::int    AS active,
                       COUNT(*) FILTER (WHERE status = 'converted')::int AS converted,
                       COUNT(*) FILTER (WHERE status = 'opted_out')::int AS opted_out,
                       COUNT(*) FILTER (WHERE status = 'expired')::int   AS expired
                  FROM customers WHERE page_id = p.id
           ) c ON TRUE
           LEFT JOIN LATERAL (
                SELECT COUNT(*) FILTER (WHERE state = 'queued')::int AS queued
                  FROM send_queue
                 WHERE page_id = p.id
                   AND scheduled_at >= date_trunc('day', now() + make_interval(hours => p.utc_offset)) - make_interval(hours => p.utc_offset)
           ) q ON TRUE
           LEFT JOIN LATERAL (
                SELECT COUNT(*) FILTER (WHERE success)::int     AS sent,
                       COUNT(*) FILTER (WHERE NOT success)::int AS failed
                  FROM send_log
                 WHERE page_id = p.id
                   AND sent_at >= date_trunc('day', now() + make_interval(hours => p.utc_offset)) - make_interval(hours => p.utc_offset)
           ) s ON TRUE
          ORDER BY p.is_active DESC, p.market, p.page_name`
    );
}

export interface Totals {
    pages_active: number;
    customers_active: number;
    queued_now: number;
    sent_24h: number;
    failed_24h: number;
    converted_24h: number;
}

export async function totals(): Promise<Totals> {
    const row = await queryOne<Totals>(
        `SELECT (SELECT COUNT(*) FROM pages WHERE is_active)::int                                    AS pages_active,
                (SELECT COUNT(*) FROM customers WHERE status = 'active')::int                        AS customers_active,
                (SELECT COUNT(*) FROM send_queue WHERE state = 'queued')::int                        AS queued_now,
                (SELECT COUNT(*) FROM send_log WHERE success AND sent_at > now() - interval '24 hours')::int     AS sent_24h,
                (SELECT COUNT(*) FROM send_log WHERE NOT success AND sent_at > now() - interval '24 hours')::int AS failed_24h,
                (SELECT COUNT(*) FROM customer_events WHERE type = 'ordered' AND occurred_at > now() - interval '24 hours')::int AS converted_24h`
    );
    return row ?? { pages_active: 0, customers_active: 0, queued_now: 0, sent_24h: 0, failed_24h: 0, converted_24h: 0 };
}

// ─── Chi tiết một page ────────────────────────────────────────────────────────

export function journeyDistribution(pageDbId: number) {
    return query<{ journey_day: number; n: number }>(
        `SELECT journey_day, COUNT(*)::int AS n FROM customers
          WHERE page_id = $1 AND status = 'active' GROUP BY 1 ORDER BY 1`,
        [pageDbId]
    );
}

export function queueBreakdown(pageDbId: number) {
    return query<{ state: QueueState; n: number }>(
        `SELECT state, COUNT(*)::int AS n FROM send_queue WHERE page_id = $1 GROUP BY 1`,
        [pageDbId]
    );
}

export function recentSends(pageDbId: number, limit = 40) {
    return query<{
        sent_at: Date; customer_id: number; customer_name: string | null; psid: string;
        journey_day: number | null; slot_index: number | null; channel: string; fb_tag: string | null;
        success: boolean; error_kind: string | null; error_message: string | null; order_index: number | null;
    }>(
        `SELECT l.sent_at, l.customer_id, c.name AS customer_name, c.psid,
                l.journey_day, l.slot_index, l.channel, l.fb_tag, l.success,
                l.error_kind, l.error_message, m.order_index
           FROM send_log l
           JOIN customers c ON c.id = l.customer_id
           LEFT JOIN script_messages m ON m.id = l.script_message_id
          WHERE l.page_id = $1
          ORDER BY l.sent_at DESC LIMIT $2`,
        [pageDbId, limit]
    );
}

export function healthHistory(pageDbId: number, limit = 24) {
    return query<{
        window_start: Date; sent: number; failed: number; error_2022: number; error_121: number;
        error_rate: string; action_taken: string | null;
    }>(
        `SELECT window_start, sent, failed, error_2022, error_121, error_rate, action_taken
           FROM page_health WHERE page_id = $1 ORDER BY window_start DESC LIMIT $2`,
        [pageDbId, limit]
    );
}

export function errorBreakdown(pageDbId: number, hours = 24) {
    return query<{ error_kind: string | null; n: number; sample: string | null }>(
        `SELECT error_kind, COUNT(*)::int AS n, (array_agg(error_message ORDER BY sent_at DESC))[1] AS sample
           FROM send_log
          WHERE page_id = $1 AND NOT success AND sent_at > now() - make_interval(hours => $2)
          GROUP BY error_kind ORDER BY n DESC`,
        [pageDbId, hours]
    );
}

// ─── Hiệu quả kịch bản ────────────────────────────────────────────────────────

export interface MessagePerformance {
    order_index: number;
    label: string | null;
    body: string;
    sent: number;
    failed: number;
    conversions: number;
}

/**
 * Tin nào ra đơn nhiều nhất.
 *
 * Cách quy công: với mỗi khách đã chốt, tìm tin CUỐI CÙNG họ nhận thành công
 * TRƯỚC thời điểm chốt, rồi tính công cho tin đó. Đây là quy ước "last touch"
 * — không hoàn hảo (khách có thể quyết định từ tin trước đó), nhưng nhất quán
 * và đủ để so sánh các tin với nhau.
 */
export function messagePerformance(pageDbId: number): Promise<MessagePerformance[]> {
    return query<MessagePerformance>(
        `WITH conv AS (
             SELECT DISTINCT ON (customer_id) customer_id, occurred_at
               FROM customer_events
              WHERE page_id = $1 AND type = 'ordered'
              ORDER BY customer_id, occurred_at
         ),
         attributed AS (
             SELECT DISTINCT ON (v.customer_id) v.customer_id, l.script_message_id
               FROM conv v
               JOIN send_log l ON l.customer_id = v.customer_id AND l.success AND l.sent_at <= v.occurred_at
              ORDER BY v.customer_id, l.sent_at DESC
         )
         SELECT m.order_index, m.label, m.body,
                COALESCE(st.sent, 0)::int   AS sent,
                COALESCE(st.failed, 0)::int AS failed,
                COALESCE(a.n, 0)::int       AS conversions
           FROM script_messages m
           JOIN scripts s ON s.id = m.script_id AND s.is_active AND s.page_id = $1
           LEFT JOIN LATERAL (
                SELECT COUNT(*) FILTER (WHERE success)::int     AS sent,
                       COUNT(*) FILTER (WHERE NOT success)::int AS failed
                  FROM send_log WHERE script_message_id = m.id
           ) st ON TRUE
           LEFT JOIN LATERAL (
                SELECT COUNT(*)::int AS n FROM attributed WHERE script_message_id = m.id
           ) a ON TRUE
          ORDER BY m.order_index`,
        [pageDbId]
    );
}

/** Khách chốt đơn ở ngày thứ mấy của hành trình. */
export function conversionByDay(pageDbId?: number) {
    return query<{ journey_day: number | null; n: number }>(
        `SELECT journey_day, COUNT(*)::int AS n
           FROM customer_events
          WHERE type = 'ordered' AND ($1::bigint IS NULL OR page_id = $1)
          GROUP BY 1 ORDER BY 1 NULLS LAST`,
        [pageDbId ?? null]
    );
}

/** Kịch bản đang bật + 12 nội dung. */
export async function activeScript(pageDbId: number) {
    const script = await queryOne<{ id: number; name: string; journey_days: number; slots_per_day: number; message_count: number }>(
        `SELECT id, name, journey_days, slots_per_day, message_count FROM scripts WHERE page_id = $1 AND is_active`,
        [pageDbId]
    );
    if (!script) return null;
    const messages = await query<{ id: number; order_index: number; label: string | null; body: string; media: string[] }>(
        `SELECT id, order_index, label, body, media FROM script_messages WHERE script_id = $1 ORDER BY order_index`,
        [script.id]
    );
    return { script, messages };
}

// ─── Tra cứu khách ────────────────────────────────────────────────────────────

export interface CustomerRow {
    id: number;
    page_id: number;
    page_name: string;
    psid: string;
    name: string | null;
    phone: string | null;
    status: CustomerStatus;
    journey_day: number;
    journey_count: number;
    order_count: number;
    order_count_baseline: number | null;
    last_interaction_at: Date;
    first_seen_at: Date;
    stop_reason: string | null;
    sent_count: number;
}

export function searchCustomers(q: string, pageDbId?: number, limit = 50): Promise<CustomerRow[]> {
    const like = `%${q.trim()}%`;
    return query<CustomerRow>(
        `SELECT c.id, c.page_id, p.page_name, c.psid, c.name, c.phone, c.status,
                c.journey_day, c.journey_count, c.order_count, c.order_count_baseline,
                c.last_interaction_at, c.first_seen_at, c.stop_reason,
                (SELECT COUNT(*)::int FROM send_log l WHERE l.customer_id = c.id AND l.success) AS sent_count
           FROM customers c JOIN pages p ON p.id = c.page_id
          WHERE ($2::bigint IS NULL OR c.page_id = $2)
            AND (c.psid = $3 OR c.name ILIKE $1 OR c.phone ILIKE $1)
          ORDER BY c.last_interaction_at DESC LIMIT $4`,
        [like, pageDbId ?? null, q.trim(), limit]
    );
}

export async function customerDetail(id: number) {
    const customer = await queryOne<CustomerRow>(
        `SELECT c.id, c.page_id, p.page_name, c.psid, c.name, c.phone, c.status,
                c.journey_day, c.journey_count, c.order_count, c.order_count_baseline,
                c.last_interaction_at, c.first_seen_at, c.stop_reason,
                (SELECT COUNT(*)::int FROM send_log l WHERE l.customer_id = c.id AND l.success) AS sent_count
           FROM customers c JOIN pages p ON p.id = c.page_id WHERE c.id = $1`,
        [id]
    );
    if (!customer) return null;

    const sends = await query<{
        sent_at: Date; journey_day: number | null; slot_index: number | null; channel: string;
        fb_tag: string | null; success: boolean; error_kind: string | null; error_message: string | null;
        order_index: number | null; label: string | null; body: string | null;
    }>(
        `SELECT l.sent_at, l.journey_day, l.slot_index, l.channel, l.fb_tag, l.success,
                l.error_kind, l.error_message, m.order_index, m.label, m.body
           FROM send_log l LEFT JOIN script_messages m ON m.id = l.script_message_id
          WHERE l.customer_id = $1 ORDER BY l.sent_at DESC LIMIT 60`,
        [id]
    );

    const events = await query<{ type: string; journey_day: number | null; payload: Record<string, unknown>; occurred_at: Date }>(
        `SELECT type::text, journey_day, payload, occurred_at FROM customer_events
          WHERE customer_id = $1 ORDER BY occurred_at DESC LIMIT 30`,
        [id]
    );

    const upcoming = await query<{ scheduled_at: Date; journey_day: number; slot_index: number; state: string; order_index: number | null }>(
        `SELECT q.scheduled_at, q.journey_day, q.slot_index, q.state::text, m.order_index
           FROM send_queue q LEFT JOIN script_messages m ON m.id = q.script_message_id
          WHERE q.customer_id = $1 AND q.state = 'queued' ORDER BY q.scheduled_at LIMIT 10`,
        [id]
    );

    return { customer, sends, events, upcoming };
}

export function pageById(id: number) {
    return queryOne<{ id: number; page_id: string; page_name: string; market: string; utc_offset: number; is_active: boolean; health_state: PageHealthState; ramp_percent: number; pancake_shop_id: string | null }>(
        `SELECT id, page_id, page_name, market, utc_offset, is_active, health_state, ramp_percent, pancake_shop_id FROM pages WHERE id = $1`,
        [id]
    );
}

export function recentJobRuns(limit = 15) {
    return query<{ job: string; page_id: number | null; started_at: Date; finished_at: Date | null; ok: boolean | null; stats: Record<string, unknown>; error: string | null }>(
        `SELECT job, page_id, started_at, finished_at, ok, stats, error FROM job_runs ORDER BY started_at DESC LIMIT $1`,
        [limit]
    );
}
