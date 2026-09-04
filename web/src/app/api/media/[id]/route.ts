import { NextRequest, NextResponse } from "next/server";
import { loadImage } from "@/lib/media";

/**
 * Phục vụ ảnh đã lưu. KHÔNG yêu cầu mật khẩu — Facebook phải tải được ảnh này
 * để hiển thị cho khách, mà Facebook thì không có mật khẩu của mình.
 * Id là chuỗi ngẫu nhiên 12 ký tự nên không đoán được.
 */
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const { id } = await ctx.params;
    if (!/^[A-Za-z0-9_-]{6,32}$/.test(id)) {
        return new NextResponse("Mã ảnh không hợp lệ", { status: 400 });
    }
    const row = await loadImage(id);
    if (!row) return new NextResponse("Không có ảnh này", { status: 404 });

    return new NextResponse(new Uint8Array(row.bytes), {
        headers: {
            "Content-Type": row.mime,
            "Content-Length": String(row.bytes.length),
            "Cache-Control": "public, max-age=31536000, immutable",
        },
    });
}
