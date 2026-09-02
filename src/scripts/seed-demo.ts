import { query, closePool } from "../db/pool.js";
import { migrate } from "../db/migrate.js";
import { config } from "../config/index.js";
import { localDateStr, localSlotToUtc } from "../lib/time.js";
import { messageIndexFor } from "../domain/journey.js";
import * as pagesRepo from "../db/repositories/pages.repo.js";
import * as scriptsRepo from "../db/repositories/scripts.repo.js";
import * as customersRepo from "../db/repositories/customers.repo.js";
import { parseFile } from "./seed-script.js";

/**
 * npm run seed:demo — dựng dữ liệu MẪU để xem dashboard trước khi có dữ liệu thật.
 *
 * ⚠️ XOÁ SẠCH mọi page có tiền tố DEMO_ rồi tạo lại. Không đụng page thật.
 *    Chỉ chạy trên database dev.
 */

const DAY = 86_400_000;
const rnd = (n: number) => Math.floor(Math.random() * n);
const pick = <T,>(a: readonly T[]): T => a[rnd(a.length)] as T;

const TEN = ["Ahmed", "Fatima", "Mohammed", "Layla", "Omar", "Noor", "Yusuf", "Sara", "Ali", "Mariam",
    "Khalid", "Aisha", "Hassan", "Zainab", "Ibrahim", "Huda", "Tariq", "Amal", "Faisal", "Rania"];

async function main(): Promise<void> {
    await migrate();
    console.log("🧹 Xoá dữ liệu DEMO cũ…");
    await query(`DELETE FROM pages WHERE page_id LIKE 'DEMO_%'`);

    const messages = parseFile("kich-ban/mau.json");
    const now = Date.now();

    const specs = [
        { id: "DEMO_SA", name: "TALPHA Saudi", market: "Saudi", off: 3, n: 420, health: "ok" as const, ramp: 100 },
        { id: "DEMO_AE", name: "TALPHA Dubai", market: "UAE", off: 4, n: 260, health: "degraded" as const, ramp: 100 },
        { id: "DEMO_JP", name: "TALPHA Japan", market: "Japan", off: 9, n: 95, health: "paused" as const, ramp: 100 },
        { id: "DEMO_TW", name: "TALPHA Taiwan", market: "Taiwan", off: 8, n: 140, health: "ok" as const, ramp: 25 },
    ];

    for (const spec of specs) {
        const page = await pagesRepo.upsert({
            pageId: spec.id, pageName: spec.name, market: spec.market,
            utcOffset: spec.off, pancakeShopId: `SHOP_${spec.market.toUpperCase()}`,
        });
        await pagesRepo.setActive(page.id, true, spec.ramp);
        await query(`UPDATE pages SET last_synced_at = now() - interval '4 hours', ramp_percent = $2 WHERE id = $1`, [page.id, spec.ramp]);
        if (spec.health === "paused") {
            await pagesRepo.pause(page.id, 30, "Facebook chặn page (#2022 ×3)");
        } else if (spec.health === "degraded") {
            await pagesRepo.degrade(page.id, "Tỉ lệ lỗi 34% trong 60 phút");
        }

        const { script } = await scriptsRepo.replaceActiveScript(page.id, `${spec.name} — tháng 9`, messages, {
            journeyDays: config.journey.days, slotsPerDay: config.journey.slotsPerDay,
        });
        const msgs = await scriptsRepo.messagesForScript(script.id);

        // Tệp khách: rải đều trên 7 ngày hành trình
        const batch = Array.from({ length: spec.n }, (_, i) => {
            const day = 1 + rnd(config.journey.days);
            return {
                psid: `${1000000000000 + rnd(900000000000)}`,
                conversationId: `${spec.id}_c${i}`,
                name: `${pick(TEN)} ${pick(["A.", "S.", "M.", "K.", "H."])}`,
                phone: Math.random() < 0.35 ? `+9665${rnd(90000000) + 10000000}` : null,
                orderCount: 0,
                tags: Math.random() < 0.15 ? ["Khách VIP"] : [],
                lastInteractionAt: new Date(now - (1 + rnd(6)) * DAY - rnd(20) * 3600_000),
                _day: day,
            };
        });
        const up = await customersRepo.upsertBatch(page.id, batch);
        await customersRepo.recordEvents(page.id, up.insertedIds, "entered");

        // Đặt ngày hành trình rải đều
        await query(
            `UPDATE customers SET first_seen_at = now() - (floor(random() * $2) || ' days')::interval WHERE page_id = $1`,
            [page.id, config.journey.days]
        );
        await customersRepo.recomputeJourneyDays(page.id, spec.off);

        const custs = await customersRepo.listForPlanning(page.id, config.journey.days);
        const today = localDateStr(spec.off, new Date());

        // Nhật ký gửi 3 ngày gần nhất + một phần chốt đơn
        const logRows: unknown[][] = [];
        const convIds: number[] = [];
        for (const c of custs) {
            const nSent = Math.min(c.journey_day, 3) * config.journey.slotsPerDay;
            for (let k = 0; k < nSent; k++) {
                const day = 1 + Math.floor(k / config.journey.slotsPerDay);
                const slot = k % config.journey.slotsPerDay;
                const mi = messageIndexFor(day, slot, config.journey.slotsPerDay, msgs.length);
                const fail = Math.random() < (spec.health === "ok" ? 0.06 : 0.3);
                const kind = fail ? pick(["OUT_OF_WINDOW", "USER_UNAVAILABLE", "PAGE_BLOCKED", "RATE_LIMITED"]) : null;
                logRows.push([
                    c.id, page.id, msgs[mi]!.id, day, slot,
                    fail || Math.random() > 0.25 ? "pancake" : "facebook",
                    !fail, kind, kind === "PAGE_BLOCKED" ? "2022" : kind ? "10" : null,
                    kind ? `Mô phỏng lỗi ${kind}` : null,
                    new Date(now - (config.journey.days - day) * DAY - rnd(20) * 3600_000).toISOString(),
                ]);
            }
            // ~9% chốt đơn
            if (Math.random() < 0.09) convIds.push(c.id);
        }

        const CH = 500;
        for (let i = 0; i < logRows.length; i += CH) {
            const chunk = logRows.slice(i, i + CH);
            await query(
                `INSERT INTO send_log (customer_id, page_id, script_message_id, journey_day, slot_index,
                                       channel, success, error_kind, error_code, error_message, sent_at)
                 SELECT * FROM unnest($1::bigint[], $2::bigint[], $3::bigint[], $4::smallint[], $5::smallint[],
                                      $6::send_channel[], $7::boolean[], $8::text[], $9::text[], $10::text[], $11::timestamptz[])`,
                Array.from({ length: 11 }, (_, col) => chunk.map((r) => r[col]))
            );
        }

        for (const id of convIds) {
            const c = custs.find((x) => x.id === id)!;
            await customersRepo.stop(id, "converted", "Chốt đơn mới trên POS (0 → 1)");
            await query(
                `INSERT INTO customer_events (customer_id, page_id, type, journey_day, occurred_at)
                 VALUES ($1, $2, 'ordered', $3, now() - (random() * 3 || ' days')::interval)`,
                [id, page.id, c.journey_day]
            );
        }

        // Hàng đợi hôm nay cho khách còn active
        const stillActive = await customersRepo.listForPlanning(page.id, config.journey.days);
        const qRows: unknown[][] = [];
        for (const c of stillActive) {
            for (let s = 0; s < config.journey.slotsPerDay; s++) {
                const hour = config.journey.slotHours[s]!;
                const mi = messageIndexFor(c.journey_day, s, config.journey.slotsPerDay, msgs.length);
                qRows.push([c.id, page.id, msgs[mi]!.id, c.journey_day, s, localSlotToUtc(today, hour, spec.off).toISOString()]);
            }
        }
        for (let i = 0; i < qRows.length; i += CH) {
            const chunk = qRows.slice(i, i + CH);
            await query(
                `INSERT INTO send_queue (customer_id, page_id, script_message_id, journey_day, slot_index, scheduled_at)
                 SELECT * FROM unnest($1::bigint[], $2::bigint[], $3::bigint[], $4::smallint[], $5::smallint[], $6::timestamptz[])
                 ON CONFLICT DO NOTHING`,
                Array.from({ length: 6 }, (_, col) => chunk.map((r) => r[col]))
            );
        }

        // Ảnh chụp sức khoẻ 8 cửa sổ gần nhất
        for (let w = 0; w < 8; w++) {
            const sent = 40 + rnd(80);
            const failed = spec.health === "ok" ? rnd(8) : 20 + rnd(30);
            await query(
                `INSERT INTO page_health (page_id, window_start, sent, failed, error_2022, error_121, error_rate, action_taken)
                 VALUES ($1, date_trunc('hour', now()) - make_interval(mins => $2), $3, $4, $5, 0, $6, $7)
                 ON CONFLICT (page_id, window_start) DO NOTHING`,
                [page.id, w * 15, sent, failed, spec.health === "paused" && w < 2 ? 3 : 0,
                 (failed / (sent + failed)).toFixed(4),
                 spec.health === "paused" && w === 0 ? "pause" : spec.health === "degraded" && w === 1 ? "degrade" : null]
            );
        }

        // Nhật ký job
        for (const job of ["sync", "plan", "send", "pos", "health"]) {
            await query(
                `INSERT INTO job_runs (job, page_id, started_at, finished_at, ok, stats)
                 VALUES ($1, $2, now() - make_interval(mins => $3), now() - make_interval(mins => $3) + interval '12 seconds', TRUE, $4)`,
                [job, page.id, rnd(120), JSON.stringify({ pages: 1, ok: true })]
            );
        }

        const st = await customersRepo.stats(page.id);
        console.log(`  ✅ ${spec.name.padEnd(16)} ${st.active} đang nuôi · ${st.converted} đã chốt · ${logRows.length} dòng nhật ký`);
    }

    console.log(`\n✅ Xong. Chạy: npm run web  → http://localhost:${process.env.DASHBOARD_PORT ?? 8090}\n`);
}

main()
    .catch((err) => {
        console.error("❌", err instanceof Error ? err.stack ?? err.message : err);
        process.exitCode = 1;
    })
    .finally(() => closePool());
