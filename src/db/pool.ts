import pg from "pg";
import { config } from "../config/index.js";
import { logger } from "../lib/logger.js";

const { Pool, types } = pg;

// BIGINT (oid 20) mặc định được pg trả về dạng chuỗi để không mất độ chính xác.
// Khoá chính của hệ thống này không bao giờ vượt Number.MAX_SAFE_INTEGER nên
// đọc thành số cho tiện; NUMERIC thì giữ nguyên chuỗi vì đó là số thập phân.
types.setTypeParser(20, (v) => Number(v));

export const pool = new Pool({
    connectionString: config.db.url,
    max: config.db.poolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: "banbot-v2",
});

pool.on("error", (err) => {
    // Lỗi trên client đang nằm không trong pool — không làm sập tiến trình.
    logger.error({ err: err.message }, "Lỗi pool Postgres");
});

export type Row = Record<string, unknown>;

/** Chạy một câu lệnh, trả về danh sách dòng. */
export async function query<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    const started = Date.now();
    try {
        const res = await pool.query(sql, params);
        return res.rows as T[];
    } catch (err) {
        logger.error(
            { sql: sql.replace(/\s+/g, " ").slice(0, 160), err: err instanceof Error ? err.message : String(err) },
            "Câu lệnh SQL lỗi"
        );
        throw err;
    } finally {
        const ms = Date.now() - started;
        if (ms > 2000) {
            logger.warn({ ms, sql: sql.replace(/\s+/g, " ").slice(0, 120) }, "Câu lệnh SQL chạy chậm");
        }
    }
}

/** Chạy một câu lệnh chỉ mong đợi tối đa 1 dòng. */
export async function queryOne<T = Row>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await query<T>(sql, params);
    return rows[0] ?? null;
}

/**
 * Chạy nhiều câu lệnh trong một transaction.
 * Lỗi ở bất kỳ đâu → ROLLBACK toàn bộ, không để lại trạng thái dở dang.
 */
export async function withTransaction<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
    } catch (err) {
        try {
            await client.query("ROLLBACK");
        } catch {
            /* client có thể đã hỏng — bỏ qua */
        }
        throw err;
    } finally {
        client.release();
    }
}

export async function closePool(): Promise<void> {
    await pool.end();
}
