import { readdirSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pool, closePool } from "./pool.js";
import { jobLogger } from "../lib/logger.js";

/**
 * Chạy migration.
 *
 * Mỗi file trong migrations/ chạy đúng MỘT lần, theo thứ tự tên file, và cả
 * file được bọc trong một transaction — file lỗi giữa chừng thì không để lại
 * schema dở dang.
 */

const log = jobLogger("migrate");
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

async function ensureTable(): Promise<void> {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            name       TEXT        PRIMARY KEY,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);
}

async function appliedNames(): Promise<Set<string>> {
    const res = await pool.query<{ name: string }>("SELECT name FROM schema_migrations");
    return new Set(res.rows.map((r) => r.name));
}

export async function migrate(): Promise<number> {
    await ensureTable();
    const done = await appliedNames();

    const files = readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith(".sql"))
        .sort();

    if (files.length === 0) {
        log.warn({ dir: MIGRATIONS_DIR }, "Không tìm thấy file migration nào");
        return 0;
    }

    let applied = 0;
    for (const file of files) {
        if (done.has(file)) {
            log.debug({ file }, "Đã chạy trước đó, bỏ qua");
            continue;
        }

        const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            await client.query(sql);
            await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
            await client.query("COMMIT");
            applied++;
            log.info({ file }, "✅ Đã áp dụng");
        } catch (err) {
            await client.query("ROLLBACK").catch(() => {});
            log.error({ file, err: err instanceof Error ? err.message : String(err) }, "❌ Migration lỗi — đã rollback");
            throw err;
        } finally {
            client.release();
        }
    }

    if (applied === 0) log.info("Schema đã ở bản mới nhất, không có gì để chạy");
    else log.info({ applied }, "Xong");

    return applied;
}

// Chạy trực tiếp: npm run migrate
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    migrate()
        .then(() => closePool())
        .then(() => process.exit(0))
        .catch(async (err) => {
            log.error({ err: err instanceof Error ? err.message : String(err) }, "Migrate thất bại");
            await closePool().catch(() => {});
            process.exit(1);
        });
}
