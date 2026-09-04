import { NextRequest, NextResponse } from "next/server";
import { requireAppKey } from "@/lib/auth";
import { query, queryOne, iso } from "@/lib/db";

/**
 * Danh sách "lịch" cho giao diện.
 *
 * Ở v1 mỗi lịch là một bản ghi riêng trong Firestore. Ở v2 khái niệm đó tách
 * làm hai: PAGE (bật/tắt, sức khoẻ) và KỊCH BẢN (12 tin). Route này ghép lại
 * thành đúng hình dạng v1 để giao diện không phải sửa.
 *
 * Việc GỬI hoàn toàn do engine lo — route này chỉ đọc và bật/tắt.
 */

export const dynamic = "force-dynamic";

const SLOT_HOURS = (process.env.SEND_SLOT_HOURS || "6,11,17,21")
    .split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n));
const SLOT_COUNT = SLOT_HOURS.length * 3; // 3 cụm × 4 khung giờ = 12 tin

interface Seg { segIdx: number; message?: string; media?: string[]; label?: string }

interface Row {
    page_id: number;
    fb_page_id: string;
    page_name: string;
    market: string;
    is_active: boolean;
    health_state: string;
    ramp_percent: number;
    last_synced_at: Date | null;
    active_customers: number;
    script_id: number | null;
    script_name: string | null;
}

export async function GET(req: NextRequest) {
    const authError = requireAppKey(req);
    if (authError) return authError;
    try {
        const rows = await query<Row>(
            `SELECT p.id AS page_id, p.page_id AS fb_page_id, p.page_name, p.market,
                    p.is_active, p.health_state, p.ramp_percent, p.last_synced_at,
                    (SELECT COUNT(*)::int FROM customers c WHERE c.page_id = p.id AND c.status = 'active') AS active_customers,
                    s.id AS script_id, s.name AS script_name
               FROM pages p
               LEFT JOIN scripts s ON s.page_id = p.id AND s.is_active
              ORDER BY p.is_active DESC, p.page_name`
        );

        const schedules = await Promise.all(rows.map(async (r) => {
            const segments = r.script_id
                ? await query<{
                      order_index: number; label: string | null; body: string; media: string[];
                      sent: number; failed: number; last_sent: Date | null;
                  }>(
                      `SELECT m.order_index, m.label, m.body, m.media,
                              COALESCE(l.sent, 0) AS sent, COALESCE(l.failed, 0) AS failed, l.last_sent
                         FROM script_messages m
                         LEFT JOIN LATERAL (
                              SELECT COUNT(*) FILTER (WHERE success)::int AS sent,
                                     COUNT(*) FILTER (WHERE NOT success)::int AS failed,
                                     MAX(sent_at) AS last_sent
                                FROM send_log WHERE script_message_id = m.id
                         ) l ON TRUE
                        WHERE m.script_id = $1 ORDER BY m.order_index`,
                      [r.script_id]
                  )
                : [];

            return {
                id: r.fb_page_id,
                shopId: r.market,
                shopName: r.market,
                pageId: r.fb_page_id,
                pageName: r.page_name,
                hour: SLOT_HOURS[0] ?? 6,
                messages: segments.map((s) => s.body),
                segments: segments.map((s) => ({
                    segIdx: s.order_index,
                    hour: SLOT_HOURS[s.order_index % SLOT_HOURS.length] ?? 6,
                    label: s.label ?? "",
                    message: s.body === "—" ? "" : s.body,
                    media: s.media ?? [],
                    status: s.sent > 0 ? "sent" : "pending",
                    successCount: s.sent,
                    errorCount: s.failed,
                    totalRecipients: s.sent + s.failed,
                    sentAt: iso(s.last_sent),
                })),
                filterPurchase: "all",
                filterTimeRange: "all",
                isActive: r.is_active,
                createdAt: "",
                lastFiredAt: iso(r.last_synced_at),
                nextFireAt: null,
                note: r.script_name ?? "",
                recipientCount: Number(r.active_customers),
                firedDates: [],
                // Riêng v2 — giao diện dùng để cảnh báo
                health: r.health_state,
                rampPercent: r.ramp_percent,
                hasScript: r.script_id !== null,
            };
        }));

        return NextResponse.json({ schedules });
    } catch (err) {
        console.error("[api/schedule] GET error:", err);
        return NextResponse.json({ error: err instanceof Error ? err.message : "Lỗi" }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    const authError = requireAppKey(req);
    if (authError) return authError;
    try {
        const body = await req.json();
        const { action, scheduleId } = body as { action: string; scheduleId?: string };

        // Bật/tắt page. Đây là công tắc DUY NHẤT quyết định có gửi hay không.
        if (action === "toggle" && scheduleId) {
            const page = await queryOne<{ id: number; is_active: boolean; activated_at: Date | null }>(
                `SELECT id, is_active, activated_at FROM pages WHERE page_id = $1`, [scheduleId]);
            if (!page) return NextResponse.json({ error: "Không có page này" }, { status: 404 });

            const turningOn = !page.is_active;
            if (turningOn) {
                const script = await queryOne<{ n: number }>(
                    `SELECT COUNT(*)::int AS n FROM scripts WHERE page_id = $1 AND is_active`, [page.id]);
                if (!script?.n) {
                    return NextResponse.json(
                        { error: "Page chưa có kịch bản — soạn nội dung trước khi bật" }, { status: 400 });
                }
            }
            await query(
                `UPDATE pages SET is_active = $2,
                        activated_at = CASE WHEN $2 AND activated_at IS NULL THEN now() ELSE activated_at END
                  WHERE id = $1`,
                [page.id, turningOn]
            );
            return NextResponse.json({ ok: true, isActive: turningOn });
        }

        // Lưu 12 tin của kịch bản.
        //
        // GIỮ NGUYÊN id của từng tin khi có thể: send_log trỏ theo id, tạo bản
        // ghi mới sẽ làm báo cáo "tin nào ra đơn" mất sạch lịch sử của tin cũ.
        if (action === "save") {
            const sched = (body as { schedule?: { pageId?: string; segments?: Seg[] } }).schedule;
            const fbPageId = String(sched?.pageId ?? "");
            const segs = sched?.segments ?? [];
            if (!fbPageId) return NextResponse.json({ error: "Thiếu page" }, { status: 400 });

            const page = await queryOne<{ id: number; page_name: string }>(
                `SELECT id, page_name FROM pages WHERE page_id = $1`, [fbPageId]);
            if (!page) return NextResponse.json({ error: "Page chưa có trong hệ thống" }, { status: 404 });

            const filled = segs.filter((x) => (x.message ?? "").trim() || (x.media ?? []).length);
            if (filled.length === 0) {
                return NextResponse.json({ error: "Chưa nhập nội dung nào" }, { status: 400 });
            }

            const script = await queryOne<{ id: number }>(
                `SELECT id FROM scripts WHERE page_id = $1 AND is_active`, [page.id]);

            let scriptId = script?.id;
            if (!scriptId) {
                const created = await queryOne<{ id: number }>(
                    `INSERT INTO scripts (page_id, name, journey_days, slots_per_day, message_count, is_active)
                     VALUES ($1, $2, 7, $3, $4, TRUE) RETURNING id`,
                    [page.id, `${page.page_name} — ${new Date().toISOString().slice(0, 10)}`,
                     SLOT_HOURS.length, SLOT_COUNT]);
                scriptId = created!.id;
            }

            for (let i = 0; i < SLOT_COUNT; i++) {
                const seg = segs.find((x) => x.segIdx === i);
                const bodyText = (seg?.message ?? "").trim();
                const media = (seg?.media ?? []).filter((u) => String(u).trim());
                // Ràng buộc CHECK ở DB không cho tin rỗng; ô chưa nhập giữ dấu gạch
                const safeBody = bodyText || (media.length ? "" : "—");
                await query(
                    `INSERT INTO script_messages (script_id, order_index, label, body, media)
                     VALUES ($1, $2, $3, $4, $5)
                     ON CONFLICT (script_id, order_index) DO UPDATE
                        SET body = EXCLUDED.body, media = EXCLUDED.media,
                            label = COALESCE(NULLIF(EXCLUDED.label, ''), script_messages.label)`,
                    [scriptId, i, seg?.label ?? null, safeBody, media]
                );
            }

            const done = filled.length;
            return NextResponse.json({
                ok: true,
                scriptId,
                filled: done,
                total: SLOT_COUNT,
                message: done === SLOT_COUNT
                    ? `Đã lưu đủ ${SLOT_COUNT} tin`
                    : `Đã lưu ${done}/${SLOT_COUNT} tin — còn ${SLOT_COUNT - done} ô chưa nhập`,
            });
        }

        return NextResponse.json({ error: `Chưa hỗ trợ thao tác: ${action}` }, { status: 400 });
    } catch (err) {
        console.error("[api/schedule] POST error:", err);
        return NextResponse.json({ error: err instanceof Error ? err.message : "Lỗi" }, { status: 500 });
    }
}
