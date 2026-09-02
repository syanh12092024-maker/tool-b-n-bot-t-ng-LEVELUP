import { query, queryOne } from "../pool.js";
import type { Customer, SyncedCustomer, CustomerEventType } from "../../domain/types.js";

/**
 * Tệp khách. Job SYNC ghi vào đây mỗi đêm; job PLAN đọc ra để xếp hàng đợi.
 *
 * Nguyên tắc: KHÔNG xoá đi làm lại. Mỗi khách giữ nguyên first_seen_at qua các
 * lần đồng bộ, vì đó là mốc quyết định họ đang ở ngày thứ mấy của hành trình.
 */

const COLS = `
    id, page_id, psid, conversation_id, name, phone, order_count, tags,
    first_seen_at, last_interaction_at, journey_day, journey_count,
    status, stop_reason, stopped_at
`;

export interface UpsertStats {
    inserted: number;
    rejoined: number;
    updated: number;
    insertedIds: number[];
    rejoinedIds: number[];
}

/**
 * Ghi một lô khách vừa quét được.
 *
 *  - Chưa có        → tạo mới, first_seen_at = now, hành trình ngày 1
 *  - Đã có, active  → chỉ cập nhật thông tin và mốc tương tác cuối
 *  - Đã có, expired và VỪA NHẮN LẠI → reset về ngày 1, đếm thêm một lần vào chuỗi
 *  - converted / opted_out → giữ nguyên trạng thái, không bao giờ tự bật lại
 */
export async function upsertBatch(pageDbId: number, batch: SyncedCustomer[]): Promise<UpsertStats> {
    const stats: UpsertStats = { inserted: 0, rejoined: 0, updated: 0, insertedIds: [], rejoinedIds: [] };
    if (batch.length === 0) return stats;

    const rows = await query<{ id: number; inserted: boolean; rejoined: boolean }>(
        `WITH incoming AS (
            SELECT *
              FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::int[], $7::jsonb[], $8::timestamptz[])
                AS t(psid, conversation_id, name, phone, order_count, tags_json, last_interaction_at)
         )
         INSERT INTO customers
             (page_id, psid, conversation_id, name, phone, order_count, tags,
              first_seen_at, last_interaction_at, journey_day, status, synced_at)
         SELECT $1, i.psid, i.conversation_id, i.name, i.phone, i.order_count,
                ARRAY(SELECT jsonb_array_elements_text(i.tags_json)),
                now(), i.last_interaction_at, 1, 'active', now()
           FROM incoming i
         ON CONFLICT (page_id, psid) DO UPDATE SET
             conversation_id     = COALESCE(EXCLUDED.conversation_id, customers.conversation_id),
             name                = COALESCE(EXCLUDED.name, customers.name),
             phone               = COALESCE(EXCLUDED.phone, customers.phone),
             order_count         = GREATEST(customers.order_count, EXCLUDED.order_count),
             tags                = EXCLUDED.tags,
             last_interaction_at = GREATEST(customers.last_interaction_at, EXCLUDED.last_interaction_at),
             synced_at           = now(),
             -- Khách rơi ra rồi nhắn lại → vào chuỗi lại từ đầu
             first_seen_at = CASE
                 WHEN customers.status = 'expired' AND EXCLUDED.last_interaction_at > customers.last_interaction_at
                 THEN now() ELSE customers.first_seen_at END,
             journey_day = CASE
                 WHEN customers.status = 'expired' AND EXCLUDED.last_interaction_at > customers.last_interaction_at
                 THEN 1 ELSE customers.journey_day END,
             journey_count = CASE
                 WHEN customers.status = 'expired' AND EXCLUDED.last_interaction_at > customers.last_interaction_at
                 THEN customers.journey_count + 1 ELSE customers.journey_count END,
             status = CASE
                 WHEN customers.status = 'expired' AND EXCLUDED.last_interaction_at > customers.last_interaction_at
                 THEN 'active'::customer_status ELSE customers.status END,
             stop_reason = CASE
                 WHEN customers.status = 'expired' AND EXCLUDED.last_interaction_at > customers.last_interaction_at
                 THEN NULL ELSE customers.stop_reason END,
             stopped_at = CASE
                 WHEN customers.status = 'expired' AND EXCLUDED.last_interaction_at > customers.last_interaction_at
                 THEN NULL ELSE customers.stopped_at END
         RETURNING id,
                   (xmax = 0)                                   AS inserted,
                   (xmax <> 0 AND first_seen_at = now())        AS rejoined`,
        [
            pageDbId,
            batch.map((c) => c.psid),
            batch.map((c) => c.conversationId),
            batch.map((c) => c.name),
            batch.map((c) => c.phone),
            batch.map((c) => c.orderCount),
            batch.map((c) => JSON.stringify(c.tags)),
            batch.map((c) => c.lastInteractionAt.toISOString()),
        ]
    );

    for (const r of rows) {
        if (r.inserted) {
            stats.inserted++;
            stats.insertedIds.push(r.id);
        } else if (r.rejoined) {
            stats.rejoined++;
            stats.rejoinedIds.push(r.id);
        } else {
            stats.updated++;
        }
    }
    return stats;
}

/** Khách nằm trong danh sách chặn thì luôn là opted_out, kể cả vừa được đồng bộ lại. */
export async function enforceOptOuts(pageDbId: number): Promise<number> {
    const rows = await query<{ id: number }>(
        `UPDATE customers c
            SET status = 'opted_out', stop_reason = 'Trong danh sách chặn', stopped_at = COALESCE(c.stopped_at, now())
           FROM opt_outs o
          WHERE o.page_id = c.page_id AND o.psid = c.psid
            AND c.page_id = $1 AND c.status <> 'opted_out'
          RETURNING c.id`,
        [pageDbId]
    );
    return rows.length;
}

/** Tính lại ngày thứ N cho mọi khách active của page, theo ngày lịch địa phương. */
export async function recomputeJourneyDays(pageDbId: number, utcOffset: number): Promise<number> {
    const rows = await query<{ id: number }>(
        `UPDATE customers
            SET journey_day = GREATEST(1,
                    ((now() + make_interval(hours => $2))::date
                   - (first_seen_at + make_interval(hours => $2))::date) + 1)
          WHERE page_id = $1 AND status = 'active'
          RETURNING id`,
        [pageDbId, utcOffset]
    );
    return rows.length;
}

/**
 * Đánh dấu hết hạn: ra khỏi cửa sổ Facebook, hoặc đã đi hết hành trình.
 * Ghi luôn sự kiện 'expired' để báo cáo biết khách rơi ở ngày mấy.
 */
export async function expireCustomers(
    pageDbId: number,
    windowDays: number,
    journeyDays: number
): Promise<{ outOfWindow: number; journeyDone: number }> {
    const rows = await query<{ reason: string }>(
        `WITH expired AS (
            UPDATE customers
               SET status = 'expired',
                   stopped_at = now(),
                   stop_reason = CASE
                       WHEN last_interaction_at < now() - make_interval(days => $2) THEN 'Ngoài cửa sổ ' || $2 || ' ngày'
                       ELSE 'Đã đi hết hành trình ' || $3 || ' ngày' END
             WHERE page_id = $1 AND status = 'active'
               AND (last_interaction_at < now() - make_interval(days => $2) OR journey_day > $3)
             RETURNING id, journey_day, stop_reason
         ),
         ev AS (
            INSERT INTO customer_events (customer_id, page_id, type, journey_day, payload)
            SELECT id, $1, 'expired', journey_day, jsonb_build_object('reason', stop_reason) FROM expired
         )
         SELECT stop_reason AS reason FROM expired`,
        [pageDbId, windowDays, journeyDays]
    );

    let outOfWindow = 0;
    let journeyDone = 0;
    for (const r of rows) {
        if (r.reason.startsWith("Ngoài cửa sổ")) outOfWindow++;
        else journeyDone++;
    }
    return { outOfWindow, journeyDone };
}

/** Khách active còn trong hành trình — đầu vào của job PLAN. */
export function listForPlanning(pageDbId: number, journeyDays: number): Promise<Customer[]> {
    return query<Customer>(
        `SELECT ${COLS} FROM customers
          WHERE page_id = $1 AND status = 'active' AND journey_day BETWEEN 1 AND $2
          ORDER BY id`,
        [pageDbId, journeyDays]
    );
}

export function findById(id: number): Promise<Customer | null> {
    return queryOne<Customer>(`SELECT ${COLS} FROM customers WHERE id = $1`, [id]);
}

export function findByPsid(pageDbId: number, psid: string): Promise<Customer | null> {
    return queryOne<Customer>(`SELECT ${COLS} FROM customers WHERE page_id = $1 AND psid = $2`, [pageDbId, psid]);
}

/** Dừng một khách với lý do rõ ràng. Trả về true nếu có thay đổi. */
export async function stop(
    id: number,
    status: "converted" | "opted_out",
    reason: string
): Promise<boolean> {
    const rows = await query<{ id: number }>(
        `UPDATE customers SET status = $2, stop_reason = $3, stopped_at = now()
          WHERE id = $1 AND status = 'active'
          RETURNING id`,
        [id, status, reason]
    );
    return rows.length > 0;
}

/** Thêm vào danh sách chặn vĩnh viễn (giữ qua mọi lần đồng bộ). */
export async function addOptOut(pageDbId: number, psid: string, keyword: string | null, raw: string | null): Promise<void> {
    await query(
        `INSERT INTO opt_outs (page_id, psid, matched_keyword, raw_message)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (page_id, psid) DO NOTHING`,
        [pageDbId, psid, keyword, raw ? raw.slice(0, 500) : null]
    );
}

export async function recordEvent(
    customerId: number,
    pageDbId: number,
    type: CustomerEventType,
    journeyDay: number | null,
    payload: Record<string, unknown> = {}
): Promise<void> {
    await query(
        `INSERT INTO customer_events (customer_id, page_id, type, journey_day, payload) VALUES ($1, $2, $3, $4, $5)`,
        [customerId, pageDbId, type, journeyDay, JSON.stringify(payload)]
    );
}

/** Ghi sự kiện cho nhiều khách một lượt — dùng sau upsert cho khách mới/quay lại. */
export async function recordEvents(pageDbId: number, ids: number[], type: CustomerEventType): Promise<void> {
    if (ids.length === 0) return;
    await query(
        `INSERT INTO customer_events (customer_id, page_id, type, journey_day)
         SELECT c.id, $1, $2, c.journey_day FROM customers c WHERE c.id = ANY($3::bigint[])`,
        [pageDbId, type, ids]
    );
}

export interface CustomerStats {
    total: number;
    active: number;
    converted: number;
    opted_out: number;
    expired: number;
    byDay: Record<number, number>;
}

export async function stats(pageDbId: number): Promise<CustomerStats> {
    const totals = await query<{ status: string; n: number }>(
        `SELECT status::text, COUNT(*)::int AS n FROM customers WHERE page_id = $1 GROUP BY status`,
        [pageDbId]
    );
    const days = await query<{ journey_day: number; n: number }>(
        `SELECT journey_day, COUNT(*)::int AS n FROM customers WHERE page_id = $1 AND status = 'active' GROUP BY journey_day ORDER BY journey_day`,
        [pageDbId]
    );

    const s: CustomerStats = { total: 0, active: 0, converted: 0, opted_out: 0, expired: 0, byDay: {} };
    for (const t of totals) {
        s.total += t.n;
        if (t.status === "active") s.active = t.n;
        else if (t.status === "converted") s.converted = t.n;
        else if (t.status === "opted_out") s.opted_out = t.n;
        else if (t.status === "expired") s.expired = t.n;
    }
    for (const d of days) s.byDay[d.journey_day] = d.n;
    return s;
}

// ─── Bổ sung cho SYNC / WEBHOOK ───────────────────────────────────────────────

/**
 * Khách có tag mua hàng → converted. Trả về id để huỷ hàng đợi và ghi sự kiện.
 * patterns là mảng LIKE, ví dụ ['%đã chốt%', '%shipped%'].
 */
export async function convertByPurchaseTags(pageDbId: number, patterns: string[]): Promise<number[]> {
    if (patterns.length === 0) return [];
    const rows = await query<{ id: number }>(
        `UPDATE customers c
            SET status = 'converted', stop_reason = 'Có tag mua hàng trên hội thoại', stopped_at = now()
          WHERE c.page_id = $1 AND c.status = 'active'
            AND EXISTS (SELECT 1 FROM unnest(c.tags) AS t WHERE lower(t) LIKE ANY($2::text[]))
          RETURNING c.id`,
        [pageDbId, patterns]
    );
    return rows.map((r) => r.id);
}

/** Khách vừa tương tác → cửa sổ 7 ngày tính lại từ lúc này. */
export async function touchInteraction(id: number, at: Date = new Date()): Promise<void> {
    await query(
        `UPDATE customers SET last_interaction_at = GREATEST(last_interaction_at, $2) WHERE id = $1`,
        [id, at.toISOString()]
    );
}
