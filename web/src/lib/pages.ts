import { query, queryOne, iso } from "./db";

/** Page đang có trong hệ thống, kèm số khách đã đồng bộ. */
export interface PageRow {
    id: number;
    page_id: string;
    page_name: string;
    market: string;
    utc_offset: number;
    is_active: boolean;
    health_state: string;
    paused_until: Date | null;
    ramp_percent: number;
    last_synced_at: Date | null;
    active_customers: number;
    total_customers: number;
    has_script: boolean;
}

export function listPages(): Promise<PageRow[]> {
    return query<PageRow>(
        `SELECT p.id, p.page_id, p.page_name, p.market, p.utc_offset, p.is_active,
                p.health_state, p.paused_until, p.ramp_percent, p.last_synced_at,
                COALESCE(c.active, 0) AS active_customers,
                COALESCE(c.total, 0)  AS total_customers,
                EXISTS (SELECT 1 FROM scripts s WHERE s.page_id = p.id AND s.is_active) AS has_script
           FROM pages p
           LEFT JOIN LATERAL (
                SELECT COUNT(*) FILTER (WHERE status = 'active')::int AS active,
                       COUNT(*)::int AS total
                  FROM customers WHERE page_id = p.id
           ) c ON TRUE
          ORDER BY p.is_active DESC, p.page_name`
    );
}

export function findPage(fbPageId: string): Promise<PageRow | null> {
    return queryOne<PageRow>(
        `SELECT p.id, p.page_id, p.page_name, p.market, p.utc_offset, p.is_active,
                p.health_state, p.paused_until, p.ramp_percent, p.last_synced_at,
                0 AS active_customers, 0 AS total_customers, FALSE AS has_script
           FROM pages p WHERE p.page_id = $1`,
        [fbPageId]
    );
}

/**
 * Khách của một page, trả về ĐÚNG hình dạng mà giao diện v1 đang đọc.
 *
 * Giữ nguyên tên trường (customerName, psid, lastInteraction…) để 1889 dòng
 * giao diện chạy được mà không phải sửa. Chỉ nguồn dữ liệu là đổi.
 */
export interface UiCustomer {
    id: string;
    customerName: string;
    customerPhone: string;
    fbId: string;
    psid: string;
    pageFbId: string;
    customerId: string;
    conversationLink: string;
    orderCount: number;
    messageCount: number;
    snippet: string;
    tags: string[];
    address: string;
    updatedAt: string;
    lastInteraction: string;
    source: "crm";
    /** Riêng của v2 — giao diện dùng để hiện nhãn trạng thái */
    status: string;
    journeyDay: number;
}

interface CustRow {
    id: number;
    psid: string;
    conversation_id: string | null;
    name: string | null;
    phone: string | null;
    order_count: number;
    tags: string[];
    last_interaction_at: Date;
    first_seen_at: Date;
    journey_day: number;
    status: string;
    page_fb_id: string;
}

export async function listCustomers(
    fbPageId: string,
    opts: { onlyActive?: boolean; limit?: number } = {}
): Promise<UiCustomer[]> {
    const rows = await query<CustRow>(
        `SELECT c.id, c.psid, c.conversation_id, c.name, c.phone, c.order_count, c.tags,
                c.last_interaction_at, c.first_seen_at, c.journey_day, c.status::text AS status,
                p.page_id AS page_fb_id
           FROM customers c JOIN pages p ON p.id = c.page_id
          WHERE p.page_id = $1
            AND ($2::boolean IS NOT TRUE OR c.status = 'active')
          ORDER BY c.last_interaction_at DESC
          LIMIT $3`,
        [fbPageId, opts.onlyActive ?? false, opts.limit ?? 5000]
    );

    return rows.map((r) => ({
        id: r.conversation_id ?? String(r.id),
        customerName: r.name ?? "Không rõ tên",
        customerPhone: r.phone ?? "",
        fbId: r.conversation_id ?? "",
        psid: r.psid,
        pageFbId: r.page_fb_id,
        customerId: String(r.id),
        conversationLink: r.conversation_id ? `https://pages.fm/conversations/${r.conversation_id}` : "",
        orderCount: r.order_count,
        messageCount: 0,
        snippet: "",
        tags: r.tags ?? [],
        address: "",
        updatedAt: iso(r.last_interaction_at),
        lastInteraction: iso(r.last_interaction_at),
        source: "crm" as const,
        status: r.status,
        journeyDay: r.journey_day,
    }));
}

/** Đếm tệp khách theo trạng thái — để giao diện nói rõ "gửi được bao nhiêu trên tổng bao nhiêu". */
export async function countCustomers(fbPageId: string): Promise<{
    total: number; active: number; expired: number; converted: number; optedOut: number;
}> {
    const r = await queryOne<{ total: number; active: number; expired: number; converted: number; opted_out: number }>(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE c.status = 'active')::int    AS active,
                COUNT(*) FILTER (WHERE c.status = 'expired')::int   AS expired,
                COUNT(*) FILTER (WHERE c.status = 'converted')::int AS converted,
                COUNT(*) FILTER (WHERE c.status = 'opted_out')::int AS opted_out
           FROM customers c JOIN pages p ON p.id = c.page_id
          WHERE p.page_id = $1`,
        [fbPageId]
    );
    return {
        total: r?.total ?? 0, active: r?.active ?? 0, expired: r?.expired ?? 0,
        converted: r?.converted ?? 0, optedOut: r?.opted_out ?? 0,
    };
}
