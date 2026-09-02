import { closePool } from "../db/pool.js";
import * as pancake from "../clients/pancake.js";
import * as pagesRepo from "../db/repositories/pages.repo.js";
import * as customersRepo from "../db/repositories/customers.repo.js";

/**
 * npm run page:list — mọi page Pancake nhìn thấy, đối chiếu với page đã đưa vào hệ thống.
 */

async function main(): Promise<void> {
    const [fromPancake, inDb] = await Promise.all([pancake.listPages(), pagesRepo.listAll()]);
    const dbById = new Map(inDb.map((p) => [p.page_id, p]));

    console.log(`\n📄 ${fromPancake.length} page từ Pancake · ${inDb.length} page trong hệ thống\n`);
    console.log(
        "   " + "PAGE ID".padEnd(18) + "TÊN".padEnd(34) + "TOKEN".padEnd(7) + "HỆ THỐNG".padEnd(12) + "THỊ TRƯỜNG".padEnd(10) + "KHÁCH"
    );
    console.log("   " + "─".repeat(92));

    for (const p of fromPancake) {
        const db = dbById.get(p.pageId);
        let state = "—";
        let market = "";
        let cust = "";
        if (db) {
            state = !db.is_active ? "tắt" : db.health_state === "ok" ? "🟢 chạy" : db.health_state === "degraded" ? "🟡 chậm" : "🔴 ngưng";
            market = db.market;
            const s = await customersRepo.stats(db.id);
            cust = `${s.active} active / ${s.total}`;
        }
        console.log(
            "   " +
                p.pageId.padEnd(18) +
                p.name.slice(0, 32).padEnd(34) +
                (p.hasToken ? "✓" : "✗").padEnd(7) +
                state.padEnd(12) +
                market.padEnd(10) +
                cust
        );
    }

    // Page có trong DB nhưng Pancake không còn thấy → token mất quyền hoặc page bị gỡ
    const seen = new Set(fromPancake.map((p) => p.pageId));
    const orphans = inDb.filter((p) => !seen.has(p.page_id));
    if (orphans.length > 0) {
        console.log(`\n⚠️  ${orphans.length} page trong hệ thống nhưng Pancake không còn thấy:`);
        for (const o of orphans) console.log(`   • ${o.page_id}  ${o.page_name}  (${o.is_active ? "đang bật!" : "đã tắt"})`);
    }
    console.log();
}

main()
    .catch((err) => {
        console.error("❌", err instanceof Error ? err.message : err);
        process.exitCode = 1;
    })
    .finally(() => closePool());
