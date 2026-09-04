import pg from "pg";

/**
 * Kết nối tới CÙNG database mà engine v2 dùng.
 *
 * Giao diện này là của bản v1, nhưng dữ liệu không còn quét trực tiếp từ Pancake
 * mỗi lần mở trang nữa — nó đọc bảng customers đã được job sync đổ sẵn. Nhờ vậy
 * danh sách khách hiện ra tức thì thay vì chờ 2–3 phút, và luôn khớp với thứ
 * engine sắp gửi.
 */

const { Pool, types } = pg;
types.setTypeParser(20, (v) => Number(v)); // BIGINT → số

declare global {
    // eslint-disable-next-line no-var
    var __banbotPool: pg.Pool | undefined;
}

// Next.js dev nạp lại module liên tục — giữ pool ở global để không mở hàng chục pool
export const pool =
    global.__banbotPool ??
    new Pool({
        connectionString: process.env.DATABASE_URL,
        max: 5,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 10_000,
        application_name: "banbot-web",
    });
if (process.env.NODE_ENV !== "production") global.__banbotPool = pool;

// Không ràng buộc T extends Record<string, unknown>: interface khai báo thường
// không có index signature nên sẽ bị TypeScript từ chối, dù đọc từ DB ra vẫn đúng.
export async function query<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = []
): Promise<T[]> {
    const res = await pool.query(sql, params);
    return res.rows as T[];
}

export async function queryOne<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = []
): Promise<T | null> {
    const rows = await query<T>(sql, params);
    return rows[0] ?? null;
}

/** Ép kiểu ngày về chuỗi ISO cho JSON — giao diện v1 đọc bằng new Date(). */
export function iso(d: Date | string | null | undefined): string {
    if (!d) return "";
    return d instanceof Date ? d.toISOString() : String(d);
}
