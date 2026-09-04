import { NextRequest, NextResponse } from "next/server";

/**
 * Bảo vệ API bằng key đơn giản.
 * - Đặt env APP_ACCESS_KEY → mọi request tới /api/broadcast* phải kèm header
 *   `x-app-key: <key>` (frontend tự hỏi key 1 lần và lưu localStorage).
 * - Không đặt env → cho qua (tương thích ngược khi chạy local kín).
 *
 * Trả về null nếu hợp lệ, hoặc NextResponse 401 để route trả thẳng về client.
 */
export function requireAppKey(req: NextRequest): NextResponse | null {
    const requiredKey = (process.env.APP_ACCESS_KEY || "").trim();
    if (!requiredKey) return null; // chưa bật auth

    const provided = (req.headers.get("x-app-key") || "").trim();
    if (provided && provided === requiredKey) return null;

    return NextResponse.json(
        { error: "Unauthorized: thiếu hoặc sai x-app-key (APP_ACCESS_KEY)" },
        { status: 401 }
    );
}

/**
 * Cron endpoint: hợp lệ khi đúng CRON_SECRET (Bearer/?secret=) HOẶC đúng APP_ACCESS_KEY
 * (để nút "Bắn ngay" trên UI vẫn dùng được khi đã đăng nhập app).
 * Không đặt env nào → cho qua.
 */
export function requireCronAuth(req: NextRequest): NextResponse | null {
    const cronSecret = (process.env.CRON_SECRET || "").trim();
    const appKey = (process.env.APP_ACCESS_KEY || "").trim();
    if (!cronSecret && !appKey) return null;

    const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
    const querySecret = (req.nextUrl.searchParams.get("secret") || "").trim();
    const headerAppKey = (req.headers.get("x-app-key") || "").trim();

    if (cronSecret && (bearer === cronSecret || querySecret === cronSecret)) return null;
    if (appKey && headerAppKey === appKey) return null;

    return NextResponse.json(
        { error: "Unauthorized: cần CRON_SECRET hoặc x-app-key hợp lệ" },
        { status: 401 }
    );
}
