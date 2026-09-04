import { NextRequest, NextResponse } from "next/server";
import { requireAppKey } from "@/lib/auth";
import { query, queryOne } from "@/lib/db";

/**
 * Bắn ngay cho những khách đang tích chọn trên giao diện.
 *
 * Route này KHÔNG tự gửi — nó chỉ đẩy vào hàng đợi, job send (chạy mỗi phút)
 * mới thực sự gửi. Nhờ vậy lượt bắn tay đi qua đúng đường của engine: chống
 * trùng, cầu dao page khi dính #2022, hãm tốc khi tỉ lệ lỗi cao, và ghi nhật
 * ký từng tin. Bản v1 có đường gửi riêng cho nút này nên bỏ qua sạch các lớp đó.
 */
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
    const authError = requireAppKey(req);
    if (authError) return authError;

    try {
        const body = (await req.json()) as {
            pageId?: string;
            psids?: string[];
            message?: string;
            media?: string[];
        };

        const fbPageId = String(body.pageId ?? "");
        const psids = (body.psids ?? []).map(String).filter(Boolean);
        const text = String(body.message ?? "").trim();
        const media = (body.media ?? []).filter((u) => typeof u === "string" && u.trim());

        if (!fbPageId) return NextResponse.json({ error: "Thiếu page" }, { status: 400 });
        if (psids.length === 0) return NextResponse.json({ error: "Chưa chọn khách nào" }, { status: 400 });
        if (!text && media.length === 0) {
            return NextResponse.json({ error: "Chưa nhập nội dung và cũng không có ảnh" }, { status: 400 });
        }

        const page = await queryOne<{ id: number; is_active: boolean; page_name: string }>(
            `SELECT id, is_active, page_name FROM pages WHERE page_id = $1`,
            [fbPageId]
        );
        if (!page) return NextResponse.json({ error: "Page chưa có trong hệ thống" }, { status: 404 });

        // Chèn thẳng bằng SQL để không phải nạp engine vào tiến trình Next.js.
        // Điều kiện status = 'active' chặn gửi cho khách đã chốt đơn hoặc đã từ
        // chối nhận tin, kể cả khi người dùng lỡ tích chọn họ trên giao diện.
        const rows = await query<{ id: number }>(
            `INSERT INTO send_queue
                (customer_id, page_id, script_message_id, journey_day, slot_index,
                 scheduled_at, manual, override_body, override_media)
             SELECT c.id, $1, NULL, c.journey_day, 0, now(), TRUE, $3, $4
               FROM customers c
              WHERE c.page_id = $1 AND c.psid = ANY($2::text[]) AND c.status = 'active'
             RETURNING id`,
            [page.id, psids, text || null, media]
        );

        const skipped = psids.length - rows.length;
        return NextResponse.json({
            ok: true,
            queued: rows.length,
            skipped,
            pageActive: page.is_active,
            message:
                rows.length === 0
                    ? "Không khách nào đủ điều kiện gửi (đã chốt đơn, đã từ chối, hoặc ngoài cửa sổ 7 ngày)"
                    : `Đã xếp ${rows.length} tin vào hàng đợi${
                          skipped > 0 ? `, bỏ qua ${skipped} khách không đủ điều kiện` : ""
                      }. Engine gửi trong vòng 1 phút.`,
        });
    } catch (err) {
        console.error("[api/send] error:", err);
        return NextResponse.json(
            { error: err instanceof Error ? err.message : "Lỗi khi xếp hàng đợi" },
            { status: 500 }
        );
    }
}

/** Tiến trình đợt bắn tay gần nhất, để giao diện hiện thanh chạy. */
export async function GET(req: NextRequest) {
    const authError = requireAppKey(req);
    if (authError) return authError;

    const url = new URL(req.url);
    const fbPageId = url.searchParams.get("pageId") ?? "";
    const sinceRaw = url.searchParams.get("since") ?? "";
    const since = sinceRaw ? new Date(sinceRaw) : new Date(Date.now() - 3600_000);
    if (!fbPageId || isNaN(since.getTime())) {
        return NextResponse.json({ error: "Thiếu pageId hoặc since không hợp lệ" }, { status: 400 });
    }

    const r = await queryOne<{
        queued: number;
        sending: number;
        sent: number;
        failed: number;
        skipped: number;
    }>(
        `SELECT COUNT(*) FILTER (WHERE q.state = 'queued')::int  AS queued,
                COUNT(*) FILTER (WHERE q.state = 'sending')::int AS sending,
                COUNT(*) FILTER (WHERE q.state = 'sent')::int    AS sent,
                COUNT(*) FILTER (WHERE q.state = 'failed')::int  AS failed,
                COUNT(*) FILTER (WHERE q.state = 'skipped')::int AS skipped
           FROM send_queue q JOIN pages p ON p.id = q.page_id
          WHERE p.page_id = $1 AND q.manual AND q.created_at >= $2`,
        [fbPageId, since]
    );
    const s = r ?? { queued: 0, sending: 0, sent: 0, failed: 0, skipped: 0 };
    const done = s.sent + s.failed + s.skipped;
    return NextResponse.json({ ...s, done, total: done + s.queued + s.sending });
}
