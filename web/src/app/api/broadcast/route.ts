import { NextRequest, NextResponse } from "next/server";
import { requireAppKey } from "@/lib/auth";
import { listPages, listCustomers, countCustomers } from "@/lib/pages";

/**
 * Nguồn dữ liệu cho giao diện.
 *
 * Bản v1 gọi thẳng Pancake mỗi lần mở trang: quét 36 cửa sổ thời gian, mất 2–3
 * phút, và kết quả có thể khác thứ engine sắp gửi. Bản này đọc bảng customers
 * mà job sync đã đổ sẵn — hiện ra tức thì và luôn khớp với engine.
 *
 * Hình dạng JSON giữ NGUYÊN như v1 để giao diện không phải sửa.
 */

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
    const authError = requireAppKey(req);
    if (authError) return authError;

    try {
        const { searchParams } = new URL(req.url);
        const getPages = searchParams.get("getPages") === "true";
        const pageFilter = searchParams.get("pageFilter") || "";

        // ─── Danh sách page ───────────────────────────────────────────────
        if (getPages) {
            const rows = await listPages();
            return NextResponse.json({
                pages: rows.map((p) => ({
                    pageId: p.page_id,
                    name: p.page_name,
                    platform: "facebook",
                    source: "db",
                    shopName: p.market,
                    // Thông tin riêng của v2 để giao diện hiện trạng thái
                    isActive: p.is_active,
                    health: p.health_state,
                    rampPercent: p.ramp_percent,
                    hasScript: p.has_script,
                    activeCustomers: Number(p.active_customers),
                    totalCustomers: Number(p.total_customers),
                    lastSyncedAt: p.last_synced_at ? p.last_synced_at.toISOString() : null,
                })),
                shopName: "Tất cả",
                totalPages: rows.length,
            });
        }

        // ─── Khách của một page ───────────────────────────────────────────
        if (pageFilter) {
            // Mặc định CHỈ lấy khách còn gửi được. Al Shifa có 7.683 khách trong tệp
            // nhưng chỉ 448 người còn trong cửa sổ 7 ngày — trả cả 7.683 vừa nặng
            // vừa gây hiểu nhầm là gửi được cho ngần ấy người.
            const showAll = searchParams.get("all") === "true";
            const customers = await listCustomers(pageFilter, { onlyActive: !showAll });
            const total = await countCustomers(pageFilter);
            return NextResponse.json({
                customers,
                total: customers.length,
                page: 1,
                totalPages: 1,
                source: "crm",
                debug: {
                    fromDatabase: true,
                    shown: customers.length,
                    activeCustomers: total.active,
                    totalInFile: total.total,
                    expired: total.expired,
                    converted: total.converted,
                },
            });
        }

        // ─── Không tham số: danh sách thị trường (thay cho shop của v1) ────
        const rows = await listPages();
        const markets = [...new Set(rows.map((p) => p.market))].sort();
        return NextResponse.json({
            shops: markets.map((m) => ({ name: m, shop_id: m })),
        });
    } catch (err) {
        console.error("[api/broadcast] GET error:", err);
        return NextResponse.json(
            { error: err instanceof Error ? err.message : "Lỗi không xác định" },
            { status: 500 }
        );
    }
}
