import { NextRequest, NextResponse } from "next/server";
import { requireAppKey } from "@/lib/auth";
import { storeImage, publicBase } from "@/lib/media";
import { queryOne } from "@/lib/db";

/** Nhận ảnh dán/kéo thả từ giao diện, trả về link dùng được để gửi cho khách. */
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
    const authError = requireAppKey(req);
    if (authError) return authError;

    try {
        const form = await req.formData();
        const files = form.getAll("images").filter((f): f is File => f instanceof File);
        if (files.length === 0) {
            return NextResponse.json({ error: "Không có ảnh nào được gửi lên" }, { status: 400 });
        }

        const fbPageId = String(form.get("pageId") ?? "");
        const page = fbPageId
            ? await queryOne<{ id: number }>(`SELECT id FROM pages WHERE page_id = $1`, [fbPageId])
            : null;

        const base = publicBase(req);
        const uploaded = [];
        for (const f of files) {
            const buf = Buffer.from(await f.arrayBuffer());
            uploaded.push(await storeImage(buf, f.type, page?.id ?? null, base));
        }
        return NextResponse.json({ ok: true, media: uploaded });
    } catch (err) {
        return NextResponse.json(
            { error: err instanceof Error ? err.message : "Tải ảnh lên thất bại" },
            { status: 400 }
        );
    }
}
