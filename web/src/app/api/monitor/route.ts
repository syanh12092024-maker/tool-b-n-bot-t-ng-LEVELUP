import { NextRequest, NextResponse } from "next/server";
import { requireAppKey } from "@/lib/auth";
import { query, queryOne, iso } from "@/lib/db";

/**
 * Số liệu theo dõi việc gửi tin.
 *
 * Toàn bộ dữ liệu đã có sẵn trong send_log / send_queue / page_health từ đầu —
 * chỉ là chưa màn hình nào đọc ra. Route này gom lại thành thứ người vận hành
 * cần biết: page nào vừa gửi, gửi được bao nhiêu, hỏng vì cái gì.
 *
 * Mốc thời gian dùng "24 giờ qua" thay vì "hôm nay": các page nằm ở 8 múi giờ
 * khác nhau nên "hôm nay" của mỗi page là một khoảng khác nhau, gộp chung lại
 * sẽ ra con số không có nghĩa.
 */
export const dynamic = "force-dynamic";

interface Totals {
    queued: number;
    sending: number;
    sent24: number;
    failed24: number;
    converted24: number;
    last_send: Date | null;
    next_due: Date | null;
}

interface PageRow {
    page_id: string;
    page_name: string;
    market: string;
    is_active: boolean;
    health_state: string;
    paused_until: Date | null;
    pause_reason: string | null;
    queued: number;
    sent24: number;
    failed24: number;
    last_send: Date | null;
    next_due: Date | null;
}

interface FeedRow {
    sent_at: Date;
    page_name: string;
    customer_name: string | null;
    psid: string;
    order_index: number | null;
    journey_day: number | null;
    slot_index: number | null;
    channel: string;
    fb_tag: string | null;
    success: boolean;
    error_kind: string | null;
    error_message: string | null;
}

interface ErrRow {
    error_kind: string | null;
    n: number;
    pages: number;
    sample: string | null;
    last_at: Date;
}

export async function GET(req: NextRequest) {
    const authError = requireAppKey(req);
    if (authError) return authError;

    try {
        const pageFilter = new URL(req.url).searchParams.get("pageId") || null;

        const [totals, pages, feed, errors] = await Promise.all([
            queryOne<Totals>(
                `SELECT
                    (SELECT COUNT(*)::int FROM send_queue WHERE state = 'queued')  AS queued,
                    (SELECT COUNT(*)::int FROM send_queue WHERE state = 'sending') AS sending,
                    (SELECT COUNT(*)::int FROM send_log WHERE success     AND sent_at > now() - interval '24 hours') AS sent24,
                    (SELECT COUNT(*)::int FROM send_log WHERE NOT success AND sent_at > now() - interval '24 hours') AS failed24,
                    (SELECT COUNT(*)::int FROM customer_events WHERE type = 'ordered' AND occurred_at > now() - interval '24 hours') AS converted24,
                    (SELECT MAX(sent_at) FROM send_log) AS last_send,
                    (SELECT MIN(scheduled_at) FROM send_queue WHERE state = 'queued') AS next_due`
            ),

            query<PageRow>(
                `SELECT p.page_id, p.page_name, p.market, p.is_active,
                        p.health_state, p.paused_until, p.pause_reason,
                        COALESCE(q.queued, 0)   AS queued,
                        COALESCE(l.sent24, 0)   AS sent24,
                        COALESCE(l.failed24, 0) AS failed24,
                        l.last_send, q.next_due
                   FROM pages p
                   LEFT JOIN LATERAL (
                        SELECT COUNT(*) FILTER (WHERE state = 'queued')::int AS queued,
                               MIN(scheduled_at) FILTER (WHERE state = 'queued') AS next_due
                          FROM send_queue WHERE page_id = p.id
                   ) q ON TRUE
                   LEFT JOIN LATERAL (
                        SELECT COUNT(*) FILTER (WHERE success     AND sent_at > now() - interval '24 hours')::int AS sent24,
                               COUNT(*) FILTER (WHERE NOT success AND sent_at > now() - interval '24 hours')::int AS failed24,
                               MAX(sent_at) AS last_send
                          FROM send_log WHERE page_id = p.id
                   ) l ON TRUE
                  ORDER BY l.last_send DESC NULLS LAST, p.page_name`
            ),

            query<FeedRow>(
                `SELECT l.sent_at, p.page_name, c.name AS customer_name, c.psid,
                        m.order_index, l.journey_day, l.slot_index,
                        l.channel::text AS channel, l.fb_tag, l.success,
                        l.error_kind, l.error_message
                   FROM send_log l
                   JOIN pages     p ON p.id = l.page_id
                   JOIN customers c ON c.id = l.customer_id
                   LEFT JOIN script_messages m ON m.id = l.script_message_id
                  WHERE ($1::text IS NULL OR p.page_id = $1)
                  ORDER BY l.sent_at DESC
                  LIMIT 60`,
                [pageFilter]
            ),

            query<ErrRow>(
                `SELECT l.error_kind,
                        COUNT(*)::int                AS n,
                        COUNT(DISTINCT l.page_id)::int AS pages,
                        (array_agg(l.error_message ORDER BY l.sent_at DESC))[1] AS sample,
                        MAX(l.sent_at)               AS last_at
                   FROM send_log l
                   JOIN pages p ON p.id = l.page_id
                  WHERE NOT l.success
                    AND l.sent_at > now() - interval '24 hours'
                    AND ($1::text IS NULL OR p.page_id = $1)
                  GROUP BY l.error_kind
                  ORDER BY n DESC`,
                [pageFilter]
            ),
        ]);

        const t = totals ?? {
            queued: 0, sending: 0, sent24: 0, failed24: 0, converted24: 0,
            last_send: null, next_due: null,
        };

        return NextResponse.json({
            totals: {
                queued: t.queued,
                sending: t.sending,
                sent24: t.sent24,
                failed24: t.failed24,
                converted24: t.converted24,
                errorRate: t.sent24 + t.failed24 > 0 ? t.failed24 / (t.sent24 + t.failed24) : 0,
                lastSend: iso(t.last_send),
                nextDue: iso(t.next_due),
            },
            pages: pages.map((p) => ({
                pageId: p.page_id,
                name: p.page_name,
                market: p.market,
                isActive: p.is_active,
                health: p.health_state,
                pausedUntil: iso(p.paused_until),
                pauseReason: p.pause_reason,
                queued: Number(p.queued),
                sent24: Number(p.sent24),
                failed24: Number(p.failed24),
                errorRate:
                    Number(p.sent24) + Number(p.failed24) > 0
                        ? Number(p.failed24) / (Number(p.sent24) + Number(p.failed24))
                        : 0,
                lastSend: iso(p.last_send),
                nextDue: iso(p.next_due),
            })),
            feed: feed.map((f) => ({
                at: iso(f.sent_at),
                page: f.page_name,
                customer: f.customer_name ?? f.psid,
                psid: f.psid,
                msgIndex: f.order_index === null ? null : f.order_index + 1,
                journeyDay: f.journey_day,
                slotIndex: f.slot_index,
                channel: f.channel,
                fbTag: f.fb_tag,
                success: f.success,
                errorKind: f.error_kind,
                errorMessage: f.error_message,
            })),
            errors: errors.map((e) => ({
                kind: e.error_kind ?? "UNKNOWN",
                count: Number(e.n),
                pages: Number(e.pages),
                sample: e.sample,
                lastAt: iso(e.last_at),
            })),
            at: new Date().toISOString(),
        });
    } catch (err) {
        console.error("[api/monitor] error:", err);
        return NextResponse.json(
            { error: err instanceof Error ? err.message : "Lỗi khi lấy số liệu" },
            { status: 500 }
        );
    }
}
