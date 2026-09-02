import { pool, query, closePool } from "../db/pool.js";
import { recentRuns } from "../db/repositories/health.repo.js";

/**
 * npm run check:db — kết nối được không, schema đã chạy chưa, bảng nào có bao nhiêu dòng.
 */

const TABLES = [
    "pages", "scripts", "script_messages", "customers", "opt_outs",
    "send_queue", "send_log", "customer_events", "page_health", "job_runs",
];

async function main(): Promise<void> {
    const t0 = Date.now();
    const ver = await pool.query<{ v: string }>("SELECT version() AS v");
    console.log(`\n✅ Kết nối OK (${Date.now() - t0}ms)`);
    console.log(`   ${ver.rows[0]?.v.split(",")[0] ?? ""}\n`);

    const mig = await query<{ name: string; applied_at: Date }>(
        `SELECT name, applied_at FROM schema_migrations ORDER BY name`
    ).catch(() => null);

    if (!mig) {
        console.log("⚠️  Chưa có bảng schema_migrations — chạy `npm run migrate` trước.\n");
        return;
    }
    console.log("📜 Migration đã chạy:");
    for (const m of mig) console.log(`   • ${m.name}  (${m.applied_at.toISOString().slice(0, 16).replace("T", " ")})`);
    console.log();

    console.log("📊 Số dòng từng bảng:");
    for (const t of TABLES) {
        const r = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${t}`).catch(() => null);
        console.log(`   ${t.padEnd(18)} ${r ? String(r[0]?.n ?? 0).padStart(8) : "  (chưa có)"}`);
    }
    console.log();

    const runs = await recentRuns(8);
    if (runs.length > 0) {
        console.log("🕒 Lượt chạy job gần nhất:");
        for (const r of runs) {
            const when = r.started_at.toISOString().slice(5, 16).replace("T", " ");
            const status = r.ok === null ? "⏳" : r.ok ? "✅" : "❌";
            const dur = r.finished_at ? `${Math.round((r.finished_at.getTime() - r.started_at.getTime()) / 1000)}s` : "…";
            console.log(`   ${status} ${when}  ${r.job.padEnd(8)} ${dur.padStart(5)}  ${r.error ? "— " + r.error.slice(0, 60) : JSON.stringify(r.stats).slice(0, 70)}`);
        }
        console.log();
    }
}

main()
    .catch((err) => {
        console.error("\n❌ Không kết nối được database:", err instanceof Error ? err.message : err);
        console.error("   Kiểm tra DATABASE_URL trong .env và Postgres có đang chạy không.\n");
        process.exitCode = 1;
    })
    .finally(() => closePool());
