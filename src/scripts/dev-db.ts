import EmbeddedPostgres from "embedded-postgres";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * npm run db:dev — Postgres thật chạy ngay trong thư mục dự án, không cần cài
 * Postgres hay Docker. Dùng cho máy dev; trên VPS dùng Postgres cài đặt thật.
 *
 * Dữ liệu nằm ở tmp/pgdata (đã gitignore). Ctrl+C để tắt, chạy lại giữ nguyên dữ liệu.
 */

const PORT = Number(process.env.DEV_PG_PORT ?? 5433);
const DIR = resolve("tmp/pgdata");
const USER = "banbot";
const PASS = "banbot";
const DB = "banbot";

const pg = new EmbeddedPostgres({
    databaseDir: DIR,
    user: USER,
    password: PASS,
    port: PORT,
    persistent: true,
    onLog: () => {},
    onError: (msg: unknown) => console.error(String(msg)),
});

const fresh = !existsSync(DIR);
if (fresh) {
    console.log(`📦 Khởi tạo cluster mới tại ${DIR}…`);
    await pg.initialise();
}
await pg.start();
if (fresh) await pg.createDatabase(DB);

console.log(`\n✅ Postgres đang chạy ở cổng ${PORT}`);
console.log(`   DATABASE_URL=postgresql://${USER}:${PASS}@127.0.0.1:${PORT}/${DB}`);
console.log(`   → dán dòng trên vào .env, rồi: npm run migrate\n   Ctrl+C để tắt.\n`);

const stop = async () => {
    console.log("\n⏹  Đang tắt Postgres…");
    await pg.stop().catch(() => {});
    process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
