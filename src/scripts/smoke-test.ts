import EmbeddedPostgres from "embedded-postgres";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * npm run test:smoke — chạy THẬT toàn bộ SQL trên một Postgres nhúng tạm.
 *
 * Không cần Postgres cài sẵn, không cần token Pancake/Facebook: test dựng DB
 * sạch, chạy migration, rồi đi qua đúng luồng SYNC → PLAN → SEND → HEALTH bằng
 * dữ liệu giả — kiểm chứng ràng buộc chống trùng, khoá SKIP LOCKED, công thức
 * xoay vòng, cửa sổ 7 ngày, khách quay lại, cầu dao page. Xong thì xoá sạch.
 *
 * Phần KHÔNG được test ở đây: gọi API Pancake/Facebook thật.
 */

// ─── Dựng Postgres tạm — PHẢI xong trước khi import config (config đọc env lúc import) ──
const PORT = 54300 + Math.floor(Math.random() * 200);
const DATA_DIR = mkdtempSync(join(tmpdir(), "banbot-smoke-"));

process.env.DATABASE_URL = `postgresql://banbot:banbot@127.0.0.1:${PORT}/banbot_smoke`;
process.env.PANCAKE_CRM_TOKEN ||= "smoke-test-token";
process.env.LOG_LEVEL = "silent";
process.env.NODE_ENV = "production"; // tránh pino-pretty mở worker thread trong test

const pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: "banbot",
    password: "banbot",
    port: PORT,
    persistent: false,
    onLog: () => {},
    onError: () => {},
});

console.log(`\n🐘 Khởi động Postgres nhúng ở cổng ${PORT}…`);
await pg.initialise();
await pg.start();
await pg.createDatabase("banbot_smoke");

// ─── Khung kiểm tra ───────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: unknown): void {
    if (ok) {
        passed++;
        console.log(`  ✅ ${name}`);
    } else {
        failed++;
        const d = detail === undefined ? "" : `  →  ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
        failures.push(`${name}${d}`);
        console.log(`  ❌ ${name}${d}`);
    }
}
function eq<T>(name: string, actual: T, expected: T): void {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    check(name, ok, ok ? undefined : `nhận ${JSON.stringify(actual)}, mong ${JSON.stringify(expected)}`);
}
function section(title: string): void {
    console.log(`\n▶ ${title}`);
}

try {
    // Import SAU khi env đã sẵn
    const { migrate } = await import("../db/migrate.js");
    const { query, queryOne, closePool } = await import("../db/pool.js");
    const { config } = await import("../config/index.js");
    const time = await import("../lib/time.js");
    const journey = await import("../domain/journey.js");
    const { PURCHASE_TAGS, matchOptOut, hasPurchaseTag } = await import("../domain/rules.js");
    const pagesRepo = await import("../db/repositories/pages.repo.js");
    const scriptsRepo = await import("../db/repositories/scripts.repo.js");
    const customersRepo = await import("../db/repositories/customers.repo.js");
    const queueRepo = await import("../db/repositories/queue.repo.js");
    const healthRepo = await import("../db/repositories/health.repo.js");
    const { planPage, rampPercentFor } = await import("../jobs/plan.js");
    const { isDueForSync } = await import("../jobs/sync.js");
    const { parseFile } = await import("./seed-script.js");
    const pino = (await import("pino")).default;
    const log = pino({ level: "silent" });

    const now = new Date();
    const DAY = 86_400_000;

    // ═══ 1. MIGRATION ═══════════════════════════════════════════════════════
    section("Migration");
    const applied = await migrate();
    eq("Áp dụng đúng 2 file migration", applied, 2);
    const tables = await query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
    );
    eq("Tạo đủ 11 bảng (10 nghiệp vụ + schema_migrations)", tables[0]?.n, 11);
    eq("Chạy migrate lần 2 không áp dụng lại", await migrate(), 0);

    // ═══ 2. PAGE ════════════════════════════════════════════════════════════
    section("Page");
    // Chọn múi giờ sao cho giờ địa phương hiện tại ≈ 05:xx → cả 4 khung giờ hôm nay đều còn ở tương lai
    let utcOffset = 5 - now.getUTCHours();
    if (utcOffset > 14) utcOffset -= 24;
    if (utcOffset < -12) utcOffset += 24;

    const page = await pagesRepo.upsert({ pageId: "SMOKE_PAGE_1", pageName: "Page thử", market: "Test", utcOffset });
    check("Tạo page", page.id > 0 && page.page_id === "SMOKE_PAGE_1");
    eq("Page mới mặc định chưa bật", page.is_active, false);

    const again = await pagesRepo.upsert({ pageId: "SMOKE_PAGE_1", pageName: "Page thử (đổi tên)", market: "Test", utcOffset });
    eq("Upsert cùng page_id giữ nguyên id", again.id, page.id);
    eq("…và cập nhật tên", again.page_name, "Page thử (đổi tên)");

    await pagesRepo.setActive(page.id, true, 25);
    const activated = await pagesRepo.findById(page.id);
    check("Bật page ghi activated_at + ramp 25%", activated?.is_active === true && activated.activated_at !== null && activated.ramp_percent === 25);
    eq("rampPercentFor ngày đầu = 25", rampPercentFor(activated!, now), 25);
    eq("isDueForSync: chưa sync bao giờ, đúng giờ 3h → tuỳ giờ hiện tại", typeof isDueForSync(activated!, now), "boolean");

    // ═══ 3. KỊCH BẢN ════════════════════════════════════════════════════════
    section("Kịch bản");
    const messages = parseFile(resolve("kich-ban/mau.json"));
    eq("mau.json có 12 nội dung", messages.length, 12);
    const s1 = await scriptsRepo.replaceActiveScript(page.id, "Bản 1", messages, { journeyDays: 7, slotsPerDay: 4 });
    eq("Kịch bản 1 có 12 nội dung", s1.messageCount, 12);
    const s2 = await scriptsRepo.replaceActiveScript(page.id, "Bản 2", messages, { journeyDays: 7, slotsPerDay: 4 });
    const active = await scriptsRepo.activeScriptForPage(page.id);
    eq("Thay kịch bản → bản mới là bản đang bật", active?.id, s2.script.id);
    const scriptCount = await queryOne<{ n: number; act: number }>(
        `SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE is_active)::int AS act FROM scripts WHERE page_id = $1`, [page.id]);
    check("Bản cũ bị tắt, không bị xoá", scriptCount?.n === 2 && scriptCount.act === 1);
    const msgs = await scriptsRepo.messagesForScript(s2.script.id);
    eq("order_index chạy 0..11 đúng thứ tự", msgs.map((m) => m.order_index), [...Array(12).keys()]);
    eq("Nhãn tin đầu", msgs[0]?.label, "A1 · chào + giới thiệu");
    let rejected = false;
    try { await query(`INSERT INTO script_messages (script_id, order_index, body, media) VALUES ($1, 99, '   ', '{}')`, [s2.script.id]); }
    catch { rejected = true; }
    check("DB từ chối nội dung rỗng (CHECK constraint)", rejected);

    // ═══ 4. TỆP KHÁCH — mô phỏng đúng thứ tự job SYNC ═══════════════════════
    section("Tệp khách (SYNC)");
    const mk = (psid: string, daysAgo: number, tags: string[] = [], phone: string | null = null) => ({
        psid, conversationId: `${page.page_id}_${psid}`, name: `Khách ${psid}`, phone, orderCount: 0, tags,
        lastInteractionAt: new Date(now.getTime() - daysAgo * DAY),
    });
    // F nằm trong danh sách chặn TRƯỚC khi sync
    await customersRepo.addOptOut(page.id, "F", "stop", "stop please");

    const batch = [
        mk("A", 1),                          // active, sẽ đặt first_seen 3 ngày trước → ngày 4
        mk("B", 10),                         // ngoài cửa sổ 7 ngày → expired
        mk("C", 2, ["Khách VIP", "đã chốt"]),// tag mua hàng → converted
        mk("D", 1),                          // sẽ mô phỏng rơi ra rồi quay lại
        mk("E", 0.5, [], "0901234567"),      // active bình thường
        mk("F", 1),                          // trong opt_outs → opted_out
        mk("G", 1),                          // sẽ đặt first_seen 9 ngày trước → hết hành trình
    ];
    const u1 = await customersRepo.upsertBatch(page.id, batch);
    eq("Lần 1: 7 khách mới", [u1.inserted, u1.rejoined, u1.updated], [7, 0, 0]);
    await customersRepo.recordEvents(page.id, u1.insertedIds, "entered");

    const u2 = await customersRepo.upsertBatch(page.id, batch);
    eq("Lần 2 cùng dữ liệu: 7 cập nhật, 0 mới", [u2.inserted, u2.rejoined, u2.updated], [0, 0, 7]);

    // D rơi ra (expired, tương tác cũ) rồi nhắn lại hôm nay
    await query(`UPDATE customers SET status = 'expired', stopped_at = now(), last_interaction_at = now() - interval '10 days' WHERE page_id = $1 AND psid = 'D'`, [page.id]);
    const u3 = await customersRepo.upsertBatch(page.id, [mk("D", 0.1)]);
    eq("D quay lại: rejoined = 1", [u3.inserted, u3.rejoined, u3.updated], [0, 1, 0]);
    const dRow = await customersRepo.findByPsid(page.id, "D");
    check("D: active, journey_count 2, journey_day reset 1", dRow?.status === "active" && dRow.journey_count === 2 && dRow.journey_day === 1);

    // Khách converted KHÔNG bao giờ tự bật lại dù có tương tác mới
    await query(`UPDATE customers SET status = 'converted' WHERE page_id = $1 AND psid = 'E'`, [page.id]);
    await customersRepo.upsertBatch(page.id, [mk("E", 0)]);
    eq("E converted vẫn converted sau sync", (await customersRepo.findByPsid(page.id, "E"))?.status, "converted");
    await query(`UPDATE customers SET status = 'active', stopped_at = NULL, stop_reason = NULL WHERE page_id = $1 AND psid = 'E'`, [page.id]);

    eq("enforceOptOuts đánh F", await customersRepo.enforceOptOuts(page.id), 1);
    const conv = await customersRepo.convertByPurchaseTags(page.id, PURCHASE_TAGS.map((t) => `%${t.toLowerCase()}%`));
    eq("Tag 'đã chốt' → converted đúng 1 khách (C)", conv.length, 1);
    eq("hasPurchaseTag nhận tag có dấu", hasPurchaseTag(["Khách VIP", "Đã Chốt đơn"]), "Đã Chốt đơn");

    // Đặt mốc hành trình rồi tính lại
    await query(`UPDATE customers SET first_seen_at = now() - interval '3 days' WHERE page_id = $1 AND psid = 'A'`, [page.id]);
    await query(`UPDATE customers SET first_seen_at = now() - interval '9 days' WHERE page_id = $1 AND psid = 'G'`, [page.id]);
    await customersRepo.recomputeJourneyDays(page.id, utcOffset);
    eq("A ở ngày thứ 4", (await customersRepo.findByPsid(page.id, "A"))?.journey_day, 4);
    eq("G ở ngày thứ 10", (await customersRepo.findByPsid(page.id, "G"))?.journey_day, 10);

    const exp = await customersRepo.expireCustomers(page.id, 7, 7);
    eq("Hết hạn: 1 ngoài cửa sổ (B) + 1 hết hành trình (G)", [exp.outOfWindow, exp.journeyDone], [1, 1]);

    const st = await customersRepo.stats(page.id);
    eq("Thống kê: 3 active / 1 converted / 1 opted_out / 2 expired", [st.active, st.converted, st.opted_out, st.expired], [3, 1, 1, 2]);
    const events = await queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n FROM customer_events WHERE page_id = $1 AND type = 'expired'`, [page.id]);
    eq("Ghi 2 sự kiện expired", events?.n, 2);

    // ═══ 5. PLAN ════════════════════════════════════════════════════════════
    section("PLAN — xếp hàng đợi");
    const freshPage = (await pagesRepo.findById(page.id))!;
    const dry = await planPage(freshPage, log, { dryRun: true });
    eq("Dry-run: 3 khách đủ điều kiện (A, D, E)", dry.eligible, 3);
    eq("Dry-run: 3 khách × 4 khung = 12 lượt (giờ địa phương ~05h, chưa qua khung nào)", dry.enqueued, 12);
    eq("Dry-run không ghi gì", (await queueRepo.countByState(page.id)).queued, 0);

    const p1 = await planPage(freshPage, log);
    eq("Xếp 12 lượt", p1.enqueued, 12);
    const p2 = await planPage(freshPage, log);
    eq("⭐ Chạy PLAN lần 2 → 0 lượt mới (UNIQUE chặn trùng)", p2.enqueued, 0);

    // Kiểm tra công thức xoay vòng ánh xạ đúng vào script_messages
    const mapping = await query<{ psid: string; journey_day: number; slot_index: number; order_index: number }>(
        `SELECT c.psid, q.journey_day, q.slot_index, m.order_index
           FROM send_queue q JOIN customers c ON c.id = q.customer_id JOIN script_messages m ON m.id = q.script_message_id
          WHERE q.page_id = $1 ORDER BY c.psid, q.slot_index`, [page.id]);
    const formulaOk = mapping.every((r) => r.order_index === journey.messageIndexFor(r.journey_day, r.slot_index, 4, 12));
    check("Mọi lượt trong hàng đợi khớp công thức ((day-1)*4+slot) mod 12", formulaOk);
    eq("A (ngày 4) khung 6h nhận tin #1 (order 0)", mapping.find((r) => r.psid === "A" && r.slot_index === 0)?.order_index, 0);
    eq("D (ngày 1) khung 17h nhận tin #3 (order 2)", mapping.find((r) => r.psid === "D" && r.slot_index === 2)?.order_index, 2);

    // scheduled_at đúng giờ địa phương
    const today = time.localDateStr(utcOffset, now);
    const slotA0 = await queryOne<{ scheduled_at: Date }>(
        `SELECT q.scheduled_at FROM send_queue q JOIN customers c ON c.id = q.customer_id WHERE c.psid = 'A' AND q.slot_index = 0`);
    eq("Khung 6h quy đổi đúng sang UTC", slotA0?.scheduled_at.toISOString(), time.localSlotToUtc(today, 6, utcOffset).toISOString());

    // ═══ 6. SEND — cơ chế hàng đợi ═════════════════════════════════════════
    section("SEND — lấy lô, khoá, ghi nhật ký");
    eq("Chưa tới giờ → không lấy được gì", (await queueRepo.pickBatch(8, "w0", page.id)).length, 0);

    // Ép 8 lượt (A + E) tới hạn
    await query(`UPDATE send_queue q SET scheduled_at = now() - interval '1 minute' FROM customers c WHERE c.id = q.customer_id AND c.psid IN ('A','E')`);
    const [w1, w2, w3] = await Promise.all([
        queueRepo.pickBatch(3, "w1", page.id), queueRepo.pickBatch(3, "w2", page.id), queueRepo.pickBatch(3, "w3", page.id),
    ]);
    const allIds = [...w1, ...w2, ...w3].map((j) => j.id);
    eq("3 worker song song lấy đủ 8 lượt", allIds.length, 8);
    eq("⭐ Không worker nào lấy trùng lượt của worker khác (SKIP LOCKED)", new Set(allIds).size, 8);
    const job0 = w1[0]!;
    check("Lượt lấy ra có đủ dữ liệu để gửi", job0.psid.length > 0 && job0.fb_page_id === page.page_id && job0.body.length > 0 && job0.last_interaction_at instanceof Date);
    eq("Trạng thái chuyển sang sending, attempt = 1", [job0.state, job0.attempt_count], ["sending", 1]);
    eq("Lấy tiếp → 0 (tất cả đang sending)", (await queueRepo.pickBatch(8, "w4", page.id)).length, 0);

    const jobs = [...w1, ...w2, ...w3];
    const [jSent1, jSent2, jBlocked, jOow, jRetry, jStuck, ...rest] = jobs;
    await queueRepo.writeLog(jSent1!, { success: true, channel: "pancake", durationMs: 120 });
    await queueRepo.markSent(jSent1!.id);
    await queueRepo.writeLog(jSent2!, { success: true, channel: "facebook", fbTag: "HUMAN_AGENT", durationMs: 300 });
    await queueRepo.markSent(jSent2!.id);
    await queueRepo.writeLog(jBlocked!, { success: false, channel: "pancake", errorKind: "PAGE_BLOCKED", errorCode: "2022", errorMessage: "(#2022)", durationMs: 90 });
    await queueRepo.markFailed(jBlocked!.id, "PAGE_BLOCKED", true);
    await queueRepo.writeLog(jOow!, { success: false, channel: "facebook", errorKind: "OUT_OF_WINDOW", errorCode: "10", durationMs: 80 });
    await queueRepo.markFailed(jOow!.id, "OUT_OF_WINDOW", false);
    await queueRepo.markFailed(jRetry!.id, "NETWORK", true);
    for (const r of rest) await queueRepo.markSkipped(r.id, "test");

    const states = await queueRepo.countByState(page.id);
    eq("Trạng thái hàng đợi", [states.sent, states.failed, states.queued, states.sending, states.skipped], [2, 1, 4 + 2, 1, 2]);
    // queued = 4 lượt của D (chưa tới giờ) + jBlocked + jRetry trả về hàng đợi = 6 · sending = jStuck

    const hist = await queueRepo.historyForCustomer(jSent1!.customer_id);
    check("Truy vết khách: có nhật ký kèm nội dung tin", hist.length >= 1 && typeof hist[0]?.body === "string");

    // Kẹt & trễ
    await query(`UPDATE send_queue SET locked_at = now() - interval '20 minutes' WHERE id = $1`, [jStuck!.id]);
    eq("releaseStuck gỡ 1 lượt kẹt 'sending' > 15 phút", await queueRepo.releaseStuck(15), 1);
    await query(`UPDATE send_queue SET scheduled_at = now() - interval '2 hours' WHERE id = $1`, [jRetry!.id]);
    eq("skipLate bỏ 1 lượt trễ > 60 phút", await queueRepo.skipLate(60), 1);

    // ═══ 7. HEALTH — thống kê & cầu dao ═════════════════════════════════════
    section("HEALTH — thống kê, ngưng, hồi phục");
    const hs = await healthRepo.statsLastMinutes(page.id, 60);
    eq("Thống kê 60 phút: 2 gửi / 2 lỗi / 1 lỗi #2022 / tỉ lệ 50%", [hs.sent, hs.failed, hs.error2022, hs.error121, hs.errorRate], [2, 2, 1, 0, 0.5]);
    await healthRepo.insertSnapshot(page.id, time.floorToMinutes(now, 15), hs, "pause");
    await healthRepo.insertSnapshot(page.id, time.floorToMinutes(now, 15), hs, null);
    eq("Snapshot cùng cửa sổ ghi đè, không nhân đôi", (await queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n FROM page_health WHERE page_id = $1`, [page.id]))?.n, 1);

    await pagesRepo.pause(page.id, 30, "test #2022");
    const paused = (await pagesRepo.findById(page.id))!;
    check("Ngưng page: state paused, đếm 1, có paused_until", paused.health_state === "paused" && paused.pause_count_24h === 1 && paused.paused_until !== null);
    eq("isSendable = false khi đang ngưng", pagesRepo.isSendable(paused, now), false);
    await query(`UPDATE send_queue SET scheduled_at = now() - interval '1 minute' WHERE page_id = $1 AND state = 'queued'`, [page.id]);
    eq("⭐ Page ngưng → pickBatch không lấy gì dù lượt đã tới hạn", (await queueRepo.pickBatch(8, "w5", page.id)).length, 0);

    await query(`UPDATE pages SET paused_until = now() - interval '1 minute' WHERE id = $1`, [page.id]);
    eq("Hết hạn ngưng → releaseExpiredPauses trả về page", await pagesRepo.releaseExpiredPauses(), [page.id]);
    eq("…và về trạng thái degraded (thận trọng)", (await pagesRepo.findById(page.id))?.health_state, "degraded");
    const afterRelease = await queueRepo.pickBatch(2, "w6", page.id);
    eq("Sau đó lấy lô lại được", afterRelease.length, 2);
    await pagesRepo.recover(page.id);
    eq("recover → ok", (await pagesRepo.findById(page.id))?.health_state, "ok");

    // ═══ 8. WEBHOOK — dừng chuỗi ═══════════════════════════════════════════
    section("WEBHOOK — chốt đơn, từ chối");
    const d = (await customersRepo.findByPsid(page.id, "D"))!;
    const dQueued = (await queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n FROM send_queue WHERE customer_id = $1 AND state = 'queued'`, [d.id]))?.n ?? 0;
    check("D còn lượt chờ trước khi chốt", dQueued > 0);
    eq("stop(D, converted) đổi trạng thái", await customersRepo.stop(d.id, "converted", "Đơn DH001"), true);
    eq("stop lần 2 không đổi gì", await customersRepo.stop(d.id, "converted", "Đơn DH001"), false);
    eq("Huỷ đúng số lượt chờ của D", await queueRepo.cancelPendingForCustomer(d.id, "đã chốt"), dQueued);
    eq("Khách converted không còn được pickBatch", (await queueRepo.pickBatch(20, "w7", page.id)).filter((j) => j.customer_id === d.id).length, 0);

    eq("matchOptOut: 'stop' ", matchOptOut("STOP"), "STOP");
    eq("matchOptOut: tiếng Việt", matchOptOut("đừng nhắn nữa nhé"), "đừng nhắn");
    eq("matchOptOut: Ả Rập", matchOptOut("توقف من فضلك"), "توقف");
    eq("matchOptOut: không bắt nhầm 'stopwatch'", matchOptOut("I bought a stopwatch"), null);
    eq("matchOptOut: bỏ qua tin dài chứa 'stop'", matchOptOut("x".repeat(130) + " stop"), null);
    await customersRepo.touchInteraction(d.id, new Date(now.getTime() + 60_000));
    check("touchInteraction đẩy last_interaction_at lên", ((await customersRepo.findById(d.id))?.last_interaction_at.getTime() ?? 0) > now.getTime());

    // ═══ 9. JOB RUNS ════════════════════════════════════════════════════════
    section("job_runs");
    const runId = await healthRepo.startJobRun("smoke", page.id);
    await healthRepo.finishJobRun(runId, true, { ok: 1 });
    const runs = await healthRepo.recentRuns(5);
    check("Ghi và đọc lại lượt chạy", runs.length === 1 && runs[0]?.job === "smoke" && runs[0].ok === true);

    // ═══ 10. XOÁ CASCADE ════════════════════════════════════════════════════
    section("Xoá page kéo theo toàn bộ dữ liệu con");
    await query(`DELETE FROM pages WHERE id = $1`, [page.id]);
    const leftovers = await queryOne<{ c: number; q: number; l: number; e: number }>(
        `SELECT (SELECT COUNT(*) FROM customers)::int AS c, (SELECT COUNT(*) FROM send_queue)::int AS q,
                (SELECT COUNT(*) FROM send_log)::int AS l, (SELECT COUNT(*) FROM customer_events)::int AS e`);
    eq("Không còn dòng mồ côi", [leftovers?.c, leftovers?.q, leftovers?.l, leftovers?.e], [0, 0, 0, 0]);

    // ═══ 11. WEBHOOK — tầng HTTP thật ═══════════════════════════════════════
    section("WEBHOOK — máy chủ HTTP");
    process.env.WEBHOOK_SECRET = "";  // config đã đọc xong từ trước; test secret ở tầng dưới
    const { createWebhookServer, parseMessage, parseOrder } = await import("../jobs/webhook.js");

    // Bộ đọc payload — chấp nhận dạng phẳng lẫn dạng lồng của Pancake
    eq("parseMessage dạng phẳng", parseMessage({ page_id: "P1", psid: "9", text: "hi" }), { pageId: "P1", psid: "9", text: "hi" });
    eq("parseMessage dạng lồng (page.id + from.id)", parseMessage({ page: { id: "P1" }, from: { id: "9" }, snippet: "hi" }), { pageId: "P1", psid: "9", text: "hi" });
    eq("parseMessage thiếu psid → null", parseMessage({ page_id: "P1" }), null);
    eq("parseOrder dạng phẳng", parseOrder({ page_id: "P1", psid: "9", order_id: "DH1" }), { pageId: "P1", psid: "9", orderId: "DH1" });

    // Dựng page + khách mới cho phần HTTP (page cũ đã bị xoá ở mục 10)
    const wPage = await pagesRepo.upsert({ pageId: "SMOKE_WEBHOOK", pageName: "Page webhook", market: "Test", utcOffset });
    await pagesRepo.setActive(wPage.id, true, 100);
    await scriptsRepo.replaceActiveScript(wPage.id, "KB webhook", messages, { journeyDays: 7, slotsPerDay: 4 });
    await customersRepo.upsertBatch(wPage.id, [mk("W1", 1), mk("W2", 1), mk("W3", 1)]);
    await planPage((await pagesRepo.findById(wPage.id))!, log);

    const server = createWebhookServer();
    const port = 18000 + Math.floor(Math.random() * 900);
    await new Promise<void>((r) => server.listen(port, () => r()));
    const base = `http://127.0.0.1:${port}`;
    const post = async (path: string, body: unknown) => {
        const res = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
    };

    const health = await fetch(base + "/health").then((r) => r.json() as Promise<Record<string, unknown>>);
    eq("GET /health trả ok", health.ok, true);
    eq("GET vào đường POST → 405", (await fetch(base + "/webhook/message")).status, 405);
    eq("Đường dẫn lạ → 404", (await post("/khong-co", {})).status, 404);
    eq("Thiếu page_id → 400", (await post("/webhook/message", { text: "hi" })).status, 400);
    eq("Page không trong hệ thống → báo rõ", (await post("/webhook/message", { page_id: "KHONG_CO", psid: "1", text: "hi" })).json.result, "page không trong hệ thống");

    // Khách trả lời bình thường: STOP_ON_REPLY=false → chuỗi tiếp tục
    const cW1 = (await customersRepo.findByPsid(wPage.id, "W1"))!;
    const cW1Before = (await queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n FROM send_queue WHERE customer_id = $1 AND state = 'queued'`, [cW1.id]))?.n ?? 0;
    const rep = await post("/webhook/message", { page_id: wPage.page_id, psid: "W1", text: "cho mình hỏi giá" });
    eq("Khách trả lời → chuỗi vẫn tiếp tục (STOP_ON_REPLY=false)", rep.json.result, "đã ghi nhận, chuỗi tiếp tục");
    eq("…và không huỷ lượt nào của W1", (await queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n FROM send_queue WHERE customer_id = $1 AND state = 'queued'`, [cW1.id]))?.n, cW1Before);
    eq("…có ghi sự kiện replied", (await queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n FROM customer_events WHERE customer_id = $1 AND type = 'replied'`, [cW1.id]))?.n, 1);
    eq("…W1 vẫn active", (await customersRepo.findById(cW1.id))?.status, "active");

    // Khách từ chối
    const cW2 = (await customersRepo.findByPsid(wPage.id, "W2"))!;
    const optOut = await post("/webhook/message", { page_id: wPage.page_id, psid: "W2", text: "đừng nhắn nữa" });
    eq("Khách từ chối → đã chặn", optOut.json.result, "đã chặn");
    eq("…W2 thành opted_out", (await customersRepo.findById(cW2.id))?.status, "opted_out");
    eq("…huỷ hết lượt chờ của W2", (await queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n FROM send_queue WHERE customer_id = $1 AND state = 'queued'`, [cW2.id]))?.n, 0);
    eq("…vào danh sách chặn vĩnh viễn", (await queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n FROM opt_outs WHERE page_id = $1 AND psid = 'W2'`, [wPage.id]))?.n, 1);
    // Sync lại: W2 phải vẫn bị chặn
    await customersRepo.upsertBatch(wPage.id, [mk("W2", 0)]);
    await customersRepo.enforceOptOuts(wPage.id);
    eq("⭐ Sync lại KHÔNG hồi sinh khách đã chặn", (await customersRepo.findById(cW2.id))?.status, "opted_out");

    // Khách chốt đơn
    const cW3 = (await customersRepo.findByPsid(wPage.id, "W3"))!;
    const order = await post("/webhook/order", { page_id: wPage.page_id, psid: "W3", order_id: "DH-123" });
    eq("Chốt đơn → dừng chuỗi", order.json.result, "đã dừng chuỗi");
    eq("…W3 thành converted", (await customersRepo.findById(cW3.id))?.status, "converted");
    eq("…huỷ hết lượt chờ của W3", (await queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n FROM send_queue WHERE customer_id = $1 AND state = 'queued'`, [cW3.id]))?.n, 0);
    eq("…ghi sự kiện ordered kèm ngày thứ mấy", (await queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n FROM customer_events WHERE customer_id = $1 AND type = 'ordered' AND journey_day IS NOT NULL`, [cW3.id]))?.n, 1);

    await new Promise<void>((r) => server.close(() => r()));

    // ═══ 12. PHÂN LOẠI LỖI API ══════════════════════════════════════════════
    section("Phân loại lỗi API");
    const { classifyPancakeError } = await import("../clients/pancake.js");
    const { classifyFacebookError, isValidPsid } = await import("../clients/facebook.js");
    eq("Pancake 121 → PAGE_QUOTA", classifyPancakeError(121, "Page đã hết gói cước"), "PAGE_QUOTA");
    eq("Pancake lỗi chữ 'gói cước' không mã → PAGE_QUOTA", classifyPancakeError("", "Trang đã hết gói cước tin nhắn"), "PAGE_QUOTA");
    eq("Pancake 2022 → PAGE_BLOCKED", classifyPancakeError(2022, "error"), "PAGE_BLOCKED");
    eq("Pancake #2022 trong chuỗi → PAGE_BLOCKED", classifyPancakeError("", "Facebook trả về (#2022) message send failed"), "PAGE_BLOCKED");
    eq("Pancake 105 → TOKEN_EXPIRED", classifyPancakeError(105, "invalid token"), "TOKEN_EXPIRED");
    eq("Pancake #10 → OUT_OF_WINDOW", classifyPancakeError("", "(#10) outside allowed window"), "OUT_OF_WINDOW");
    eq("Pancake 'không có mặt' → USER_UNAVAILABLE", classifyPancakeError(551, "Người này hiện không có mặt"), "USER_UNAVAILABLE");
    eq("Facebook 2022 → PAGE_BLOCKED", classifyFacebookError(2022, null, "blocked"), "PAGE_BLOCKED");
    eq("Facebook 613 → RATE_LIMITED", classifyFacebookError(613, null, "calls too many"), "RATE_LIMITED");
    eq("Facebook 100 'no matching user' → INVALID_RECIPIENT", classifyFacebookError(100, null, "No matching user found"), "INVALID_RECIPIENT");
    eq("Facebook 100 chưa duyệt tag → UNKNOWN (để thang tag xử lý)", classifyFacebookError(100, null, "Tag not approved"), "UNKNOWN");
    eq("PSID số dài hợp lệ", isValidPsid("1234567890123"), true);
    eq("PSID id nội bộ Pancake không hợp lệ", isValidPsid("abc123def"), false);
    eq("PSID quá ngắn không hợp lệ", isValidPsid("12345"), false);

    // ═══ 13. THỜI GIAN & MÚI GIỜ ════════════════════════════════════════════
    section("Thời gian & múi giờ");
    eq("localSlotToUtc: 6h ở UTC+3 → 03:00Z", time.localSlotToUtc("2026-09-02", 6, 3).toISOString(), "2026-09-02T03:00:00.000Z");
    eq("localSlotToUtc: 6h ở UTC+9 (Tokyo) → 21:00Z hôm trước", time.localSlotToUtc("2026-09-02", 6, 9).toISOString(), "2026-09-01T21:00:00.000Z");
    eq("localDateStr đổi ngày đúng ở UTC+9", time.localDateStr(9, new Date("2026-09-01T16:30:00Z")), "2026-09-02");
    eq("journeyDayFor cùng ngày = 1", time.journeyDayFor(new Date("2026-09-02T01:00:00Z"), 3, new Date("2026-09-02T20:00:00Z")), 1);
    // 20:00Z = 23:00 giờ UTC+3 (ngày 1) · 22:00Z = 01:00 giờ UTC+3 (ngày 2) → vắt qua nửa đêm ĐỊA PHƯƠNG
    eq("journeyDayFor: vắt qua nửa đêm địa phương = 2", time.journeyDayFor(new Date("2026-09-01T20:00:00Z"), 3, new Date("2026-09-01T22:00:00Z")), 2);
    // Cùng ngày địa phương dù cách nhau 4 tiếng và vắt qua nửa đêm UTC → vẫn là ngày 1
    eq("journeyDayFor: vắt qua nửa đêm UTC nhưng cùng ngày địa phương = 1", time.journeyDayFor(new Date("2026-09-01T22:00:00Z"), 3, new Date("2026-09-02T02:00:00Z")), 1);
    eq("isWithinSendWindow: 6 ngày còn trong cửa sổ", time.isWithinSendWindow(new Date(now.getTime() - 6 * DAY), 7, now), true);
    eq("isWithinSendWindow: 8 ngày ngoài cửa sổ", time.isWithinSendWindow(new Date(now.getTime() - 8 * DAY), 7, now), false);

    await query(`DELETE FROM pages WHERE page_id = 'SMOKE_WEBHOOK'`);

    // ═══ 14. POS — đối chiếu đơn hàng ═══════════════════════════════════════
    section("POS — đối chiếu đơn hàng");
    const posClient = await import("../clients/pos.js");

    eq("splitFbId cắt ở gạch dưới ĐẦU TIÊN", posClient.splitFbId("123456_9876_54"), { pageId: "123456", psid: "9876_54" });
    eq("splitFbId từ chối chuỗi không có gạch", posClient.splitFbId("123456"), null);
    eq("splitFbId từ chối gạch ở đầu", posClient.splitFbId("_9876"), null);
    eq("splitFbId từ chối gạch ở cuối", posClient.splitFbId("123456_"), null);

    // Dựng page + khách để đối chiếu
    const pPage = await pagesRepo.upsert({ pageId: "SMOKE_POS", pageName: "Page POS", market: "Test", utcOffset, pancakeShopId: "SHOP_1" });
    await pagesRepo.setActive(pPage.id, true, 100);
    await scriptsRepo.replaceActiveScript(pPage.id, "KB POS", messages, { journeyDays: 7, slotsPerDay: 4 });
    await customersRepo.upsertBatch(pPage.id, [mk("P1", 1), mk("P2", 1), mk("P3", 1)]);
    await planPage((await pagesRepo.findById(pPage.id))!, log);

    const pid = async (psid: string) => (await customersRepo.findByPsid(pPage.id, psid))!;
    const queuedFor = async (id: number) =>
        (await queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n FROM send_queue WHERE customer_id = $1 AND state = 'queued'`, [id]))?.n ?? 0;

    // Lượt 1: P1 chưa đơn, P2 đã có 3 đơn từ trước, P3 chưa đơn
    const r1 = await customersRepo.applyPosOrders(pPage.id, [
        { psid: "P1", orderCount: 0 }, { psid: "P2", orderCount: 3 }, { psid: "P3", orderCount: 0 },
    ], "increase");
    eq("Lượt đầu: ghi mốc chuẩn cho cả 3, chưa ai converted", [r1.matched, r1.baselineSet, r1.converted], [3, 3, 0]);
    eq("⭐ Khách đã mua TỪ TRƯỚC vẫn được nuôi dưỡng tiếp (mode increase)", (await pid("P2")).status, "active");
    eq("…mốc chuẩn của P2 = 3 đơn sẵn có", (await pid("P2")).order_count_baseline, 3);

    // Lượt 2: P1 vừa chốt 1 đơn, P2 giữ nguyên 3, P3 vẫn 0
    const p1Queued = await queuedFor((await pid("P1")).id);
    check("P1 còn lượt chờ trước khi chốt", p1Queued > 0);
    const r2 = await customersRepo.applyPosOrders(pPage.id, [
        { psid: "P1", orderCount: 1 }, { psid: "P2", orderCount: 3 }, { psid: "P3", orderCount: 0 },
    ], "increase");
    eq("Lượt 2: chỉ P1 converted", [r2.converted, r2.baselineSet], [1, 0]);
    eq("…P1 thành converted", (await pid("P1")).status, "converted");
    eq("…lý do ghi rõ 0 → 1", (await pid("P1")).stop_reason, "Chốt đơn mới trên POS (0 → 1)");
    eq("…P2 mua từ trước vẫn active", (await pid("P2")).status, "active");
    eq("…P3 chưa đơn vẫn active", (await pid("P3")).status, "active");
    eq("Huỷ lượt chờ của P1", await queueRepo.cancelPendingForCustomer((await pid("P1")).id, "POS"), p1Queued);

    // P2 mua thêm đơn thứ 4 → giờ mới converted
    const r3 = await customersRepo.applyPosOrders(pPage.id, [{ psid: "P2", orderCount: 4 }], "increase");
    eq("P2 mua thêm đơn → converted", r3.converted, 1);
    eq("…lý do ghi rõ 3 → 4", (await pid("P2")).stop_reason, "Chốt đơn mới trên POS (3 → 4)");

    // Khách quay lại chuỗi mới phải được cấp mốc chuẩn MỚI
    const posP2 = await pid("P2");
    await query(`UPDATE customers SET status = 'expired', last_interaction_at = now() - interval '10 days' WHERE id = $1`, [posP2.id]);
    const back = await customersRepo.upsertBatch(pPage.id, [mk("P2", 0.1)]);
    eq("P2 quay lại chuỗi", back.rejoined, 1);
    await customersRepo.resetPosBaseline(back.rejoinedIds);
    eq("⭐ Mốc chuẩn bị xoá khi vào chuỗi mới", (await pid("P2")).order_count_baseline, null);
    const r4 = await customersRepo.applyPosOrders(pPage.id, [{ psid: "P2", orderCount: 4 }], "increase");
    eq("…lượt POS kế tiếp ghi mốc mới = 4, không converted oan", [r4.baselineSet, r4.converted], [1, 0]);
    eq("…P2 vẫn active trong chuỗi mới", (await pid("P2")).status, "active");
    const r5 = await customersRepo.applyPosOrders(pPage.id, [{ psid: "P2", orderCount: 5 }], "increase");
    eq("…mua tiếp đơn thứ 5 → converted trong chuỗi mới", r5.converted, 1);

    // mode 'any': ai từng có đơn đều dừng
    await customersRepo.upsertBatch(pPage.id, [mk("P4", 1)]);
    await customersRepo.applyPosOrders(pPage.id, [{ psid: "P4", orderCount: 7 }], "increase");
    eq("mode increase: P4 có 7 đơn cũ vẫn active", (await pid("P4")).status, "active");
    const rAny = await customersRepo.applyPosOrders(pPage.id, [{ psid: "P4", orderCount: 7 }], "any");
    eq("mode any: P4 converted ngay", rAny.converted, 1);
    eq("…lý do khác hẳn", (await pid("P4")).stop_reason, "Đã có đơn trên POS (7)");

    // Không đụng tới khách đã dừng vì lý do khác
    await customersRepo.upsertBatch(pPage.id, [mk("P5", 1)]);
    const posP5 = await pid("P5");
    await customersRepo.stop(posP5.id, "opted_out", "Khách từ chối");
    await customersRepo.applyPosOrders(pPage.id, [{ psid: "P5", orderCount: 9 }], "any");
    eq("Khách opted_out không bị POS ghi đè thành converted", (await customersRepo.findById(posP5.id))?.status, "opted_out");

    // psid không có trong tệp thì bỏ qua, không tạo dòng mới
    const beforeCount = (await queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n FROM customers WHERE page_id = $1`, [pPage.id]))?.n;
    await customersRepo.applyPosOrders(pPage.id, [{ psid: "KHONG_CO_TRONG_TEP", orderCount: 5 }], "increase");
    eq("psid lạ từ POS không tạo khách mới", (await queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n FROM customers WHERE page_id = $1`, [pPage.id]))?.n, beforeCount);

    await query(`DELETE FROM pages WHERE page_id = 'SMOKE_POS'`);

    // ═══ 15. DASHBOARD ══════════════════════════════════════════════════════
    section("Dashboard");
    const htmlLib = await import("../web/html.js");

    // XSS: tên khách lấy từ Facebook, không được tin
    const evil = '<script>alert(1)</script>';
    eq("esc chặn thẻ script", htmlLib.esc(evil), "&lt;script&gt;alert(1)&lt;/script&gt;");
    eq("esc chặn ngoặc kép trong thuộc tính", htmlLib.esc('" onload="x'), "&quot; onload=&quot;x");
    eq("esc xử lý null", htmlLib.esc(null), "");
    eq("truncate cắt và thêm dấu …", htmlLib.truncate("abcdefghij", 5), "abcd…");
    eq("truncate gộp khoảng trắng", htmlLib.truncate("a\n\nb   c", 20), "a b c");

    // Dựng dữ liệu có thật để render
    const dPage = await pagesRepo.upsert({ pageId: "SMOKE_WEB", pageName: "Page dashboard", market: "Test", utcOffset, pancakeShopId: "SHOP_9" });
    await pagesRepo.setActive(dPage.id, true, 100);
    const dScript = await scriptsRepo.replaceActiveScript(dPage.id, "KB dashboard", messages, { journeyDays: 7, slotsPerDay: 4 });
    // Khách có tên độc hại — phải bị escape khi hiện ra
    await customersRepo.upsertBatch(dPage.id, [
        { ...mk("W_EVIL", 1), name: evil },
        mk("W_OK", 2),
    ]);
    await planPage((await pagesRepo.findById(dPage.id))!, log);

    // Một khách nhận tin rồi chốt đơn → có dữ liệu cho báo cáo quy công
    const evilCust = (await customersRepo.findByPsid(dPage.id, "W_EVIL"))!;
    const dMsgs = await scriptsRepo.messagesForScript(dScript.script.id);
    await query(
        `INSERT INTO send_log (customer_id, page_id, script_message_id, journey_day, slot_index, channel, success, sent_at)
         VALUES ($1, $2, $3, 1, 0, 'pancake', TRUE, now() - interval '2 hours')`,
        [evilCust.id, dPage.id, dMsgs[2]!.id]
    );
    await customersRepo.stop(evilCust.id, "converted", "Chốt đơn thử");
    await customersRepo.recordEvent(evilCust.id, dPage.id, "ordered", 1, { orderId: "DH-WEB" });

    const { createDashboardServer } = await import("../web/server.js");
    const web = createDashboardServer();
    const webPort = 19000 + Math.floor(Math.random() * 900);
    await new Promise<void>((r) => web.listen(webPort, () => r()));
    const wb = `http://127.0.0.1:${webPort}`;
    const get = async (p: string) => {
        const r = await fetch(wb + p);
        return { status: r.status, body: await r.text() };
    };

    const homeRes = await get("/");
    eq("GET / trả 200", homeRes.status, 200);
    check("Trang chủ có tên page", homeRes.body.includes("Page dashboard"));
    check("Trang chủ là HTML hoàn chỉnh", homeRes.body.startsWith("<!doctype html>") && homeRes.body.includes("</html>"));

    const pageRes = await get(`/page/${dPage.id}`);
    eq("GET /page/:id trả 200", pageRes.status, 200);
    check("⭐ Tên khách độc hại bị escape, KHÔNG chèn được script", !pageRes.body.includes("<script>alert(1)</script>"));
    check("…và vẫn hiện ra dạng văn bản", pageRes.body.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));

    eq("GET /page/:id/script trả 200", (await get(`/page/${dPage.id}/script`)).status, 200);
    check("Trang kịch bản có bảng xoay vòng", (await get(`/page/${dPage.id}/script`)).body.includes("Lịch một khách sẽ nhận"));

    const repRes = await get(`/report?page=${dPage.id}`);
    eq("GET /report trả 200", repRes.status, 200);
    check("Báo cáo quy công cho tin #3 (tin cuối trước khi chốt)", repRes.body.includes("Tin nào ra đơn nhiều nhất"));
    const perf = await (await import("../db/repositories/report.repo.js")).messagePerformance(dPage.id);
    eq("⭐ Quy công đúng vào tin cuối nhận trước lúc chốt", perf.find((m) => m.order_index === 2)?.conversions, 1);
    eq("…các tin khác không được tính công", perf.filter((m) => m.conversions > 0).length, 1);

    eq("GET /customer/:id trả 200", (await get(`/customer/${evilCust.id}`)).status, 200);
    eq("GET /search có kết quả", (await get("/search?q=W_OK")).status, 200);
    check("Tìm theo PSID ra đúng khách", (await get("/search?q=W_OK")).body.includes("W_OK"));
    eq("GET /jobs trả 200", (await get("/jobs")).status, 200);
    eq("GET /healthz trả 200", (await get("/healthz")).status, 200);
    eq("Trang không tồn tại → 404", (await get("/khong-co-trang-nay")).status, 404);
    eq("Page id không tồn tại → 404", (await get("/page/999999")).status, 404);
    eq("Khách id không tồn tại → 404", (await get("/customer/999999")).status, 404);
    // Chỉ /page/:id/script nhận POST; mọi đường dẫn khác không có chỗ ghi
    eq("POST vào đường dẫn không ghi được → 404", (await fetch(wb + "/", { method: "POST", headers: { Origin: wb } })).status, 404);
    eq("PUT/DELETE vẫn bị từ chối hoàn toàn", (await fetch(wb + "/", { method: "DELETE" })).status, 405);

    await new Promise<void>((r) => web.close(() => r()));
    await query(`DELETE FROM pages WHERE page_id = 'SMOKE_WEB'`);

    // ═══ 16. ĐIỂM VÀO JOB (isMain) ══════════════════════════════════════════
    section("Điểm vào job — chạy đúng dưới pm2");
    const runner = await import("../lib/runner.js");
    const selfUrl = new URL("../lib/runner.js", import.meta.url).href;
    const selfPath = (await import("node:url")).fileURLToPath(selfUrl);

    const savedArgv1 = process.argv[1];
    const savedPm2 = process.env.pm_exec_path;
    try {
        // Chạy thẳng: node dist/lib/runner.js
        process.argv[1] = selfPath;
        delete process.env.pm_exec_path;
        eq("Chạy thẳng bằng node → là entrypoint", runner.isMain(selfUrl), true);

        // ⭐ pm2 fork mode: argv[1] là wrapper của pm2, đường dẫn thật ở pm_exec_path.
        // Thiếu nhánh này thì mọi job thoát ngay và pm2 restart vô hạn.
        process.argv[1] = "/usr/lib/node_modules/pm2/lib/ProcessContainerFork.js";
        process.env.pm_exec_path = selfPath;
        eq("⭐ Dưới pm2 fork mode → vẫn nhận ra là entrypoint", runner.isMain(selfUrl), true);

        // Bị import từ file khác thì KHÔNG được tự chạy
        process.argv[1] = "/opt/banbot/dist/jobs/send.js";
        process.env.pm_exec_path = "/opt/banbot/dist/jobs/send.js";
        eq("Bị import từ job khác → không tự chạy", runner.isMain(selfUrl), false);

        delete process.env.pm_exec_path;
        process.argv[1] = "/opt/banbot/dist/jobs/send.js";
        eq("Không có pm_exec_path và argv1 khác → không tự chạy", runner.isMain(selfUrl), false);
    } finally {
        if (savedArgv1 !== undefined) process.argv[1] = savedArgv1;
        if (savedPm2 === undefined) delete process.env.pm_exec_path;
        else process.env.pm_exec_path = savedPm2;
    }

    // ═══ 17. SỬA KỊCH BẢN TRÊN WEB ══════════════════════════════════════════
    section("Sửa kịch bản trên web");
    const ePage = await pagesRepo.upsert({ pageId: "SMOKE_EDIT", pageName: "Page sửa", market: "Test", utcOffset });
    await pagesRepo.setActive(ePage.id, true, 100);
    const eScript = await scriptsRepo.replaceActiveScript(ePage.id, "KB sửa", messages, { journeyDays: 7, slotsPerDay: 4 });
    const eMsgs = await scriptsRepo.messagesForScript(eScript.script.id);
    const firstId = eMsgs[0]!.id;

    // Có nhật ký gửi trỏ vào tin này → id PHẢI giữ nguyên sau khi sửa
    await customersRepo.upsertBatch(ePage.id, [mk("E1", 1)]);
    const eCust = (await customersRepo.findByPsid(ePage.id, "E1"))!;
    await query(
        `INSERT INTO send_log (customer_id, page_id, script_message_id, journey_day, slot_index, channel, success)
         VALUES ($1, $2, $3, 1, 0, 'pancake', TRUE)`, [eCust.id, ePage.id, firstId]);

    const edited = await scriptsRepo.updateMessageBodies(eScript.script.id, [
        { orderIndex: 0, body: "Nội dung MỚI cho tin 1", media: ["https://x/a.jpg"], label: "nhãn mới" },
        { orderIndex: 1, body: "Nội dung MỚI cho tin 2", media: [], label: null },
    ]);
    eq("Sửa 2 tin", edited, 2);
    const afterEdit = await scriptsRepo.messagesForScript(eScript.script.id);
    eq("Chữ đã đổi", afterEdit[0]?.body, "Nội dung MỚI cho tin 1");
    eq("Ảnh đã đổi", afterEdit[0]?.media, ["https://x/a.jpg"]);
    eq("Nhãn đã đổi", afterEdit[0]?.label, "nhãn mới");
    eq("Nhãn để trống thì giữ nhãn cũ", afterEdit[1]?.label, eMsgs[1]?.label);
    eq("⭐ id của tin GIỮ NGUYÊN — báo cáo không mất lịch sử", afterEdit[0]?.id, firstId);
    eq("…nhật ký gửi vẫn trỏ đúng tin đó",
        (await queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n FROM send_log WHERE script_message_id = $1`, [firstId]))?.n, 1);
    eq("Số tin không đổi (không tạo thêm bản mới)", afterEdit.length, 12);
    eq("Vẫn chỉ 1 kịch bản đang bật",
        (await queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n FROM scripts WHERE page_id = $1 AND is_active`, [ePage.id]))?.n, 1);

    let rejectedEmpty = false;
    try {
        await scriptsRepo.updateMessageBodies(eScript.script.id, [{ orderIndex: 2, body: "   ", media: [], label: null }]);
    } catch (err) {
        rejectedEmpty = /bỏ trống/.test(err instanceof Error ? err.message : "");
    }
    check("Từ chối tin rỗng, báo lỗi tiếng Việt rõ ràng", rejectedEmpty);
    eq("…và KHÔNG ghi đè tin nào khi có lỗi (transaction)",
        (await scriptsRepo.messagesForScript(eScript.script.id))[2]?.body, eMsgs[2]?.body);

    // HTTP: form + chống CSRF
    const { createDashboardServer: mkSrv } = await import("../web/server.js");
    const web2 = mkSrv();
    const port2 = 19900 + Math.floor(Math.random() * 90);
    await new Promise<void>((r) => web2.listen(port2, () => r()));
    const base2 = `http://127.0.0.1:${port2}`;

    eq("GET trang sửa trả 200", (await fetch(`${base2}/page/${ePage.id}/script/edit`)).status, 200);
    const editHtml = await (await fetch(`${base2}/page/${ePage.id}/script/edit`)).text();
    check("Form có đủ 12 ô nhập", (editHtml.match(/name="body_\d+"/g) ?? []).length === 12);
    check("Trang kịch bản có nút Sửa", (await (await fetch(`${base2}/page/${ePage.id}/script`)).text()).includes("Sửa nội dung"));

    const formBody = new URLSearchParams({ "body_0": "Sửa qua web", "media_0": "", "label_0": "web" });
    const noRef = await fetch(`${base2}/page/${ePage.id}/script`, {
        method: "POST", body: formBody, redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    eq("⭐ POST không có Origin/Referer → 403 (chống CSRF)", noRef.status, 403);
    eq("…nội dung KHÔNG bị đổi", (await scriptsRepo.messagesForScript(eScript.script.id))[0]?.body, "Nội dung MỚI cho tin 1");

    const withOrigin = await fetch(`${base2}/page/${ePage.id}/script`, {
        method: "POST", body: formBody, redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: base2 },
    });
    eq("POST từ đúng trang → 303 chuyển hướng", withOrigin.status, 303);
    check("…chuyển về trang sửa kèm báo đã lưu", (withOrigin.headers.get("location") ?? "").includes("saved=1"));
    eq("…nội dung đã lưu thật", (await scriptsRepo.messagesForScript(eScript.script.id))[0]?.body, "Sửa qua web");

    const evilOrigin = await fetch(`${base2}/page/${ePage.id}/script`, {
        method: "POST", body: new URLSearchParams({ "body_0": "HACK" }), redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "http://ke-gian.example.com" },
    });
    eq("⭐ POST từ trang lạ → 403", evilOrigin.status, 403);
    eq("…nội dung vẫn nguyên", (await scriptsRepo.messagesForScript(eScript.script.id))[0]?.body, "Sửa qua web");

    eq("POST vào đường dẫn không nhận dữ liệu → 404",
        (await fetch(`${base2}/`, { method: "POST", headers: { Origin: base2 } })).status, 404);
    eq("PUT vẫn bị từ chối", (await fetch(`${base2}/`, { method: "PUT" })).status, 405);

    await new Promise<void>((r) => web2.close(() => r()));
    await query(`DELETE FROM pages WHERE page_id = 'SMOKE_EDIT'`);

    // ═══ 18. PHÂN TÍCH HỘI THOẠI ════════════════════════════════════════════
    section("Phân tích hội thoại (không dùng AI)");
    const ca = await import("../domain/chat-analysis.js");
    const pc = await import("../clients/pancake.js");

    // Bóc HTML — Pancake gói tin trong thẻ và trả cả thực thể dạng số
    eq("stripHtml bóc thẻ div", pc.stripHtml("<div>Xin chào</div>"), "Xin chào");
    eq("stripHtml đổi <br> thành xuống dòng", pc.stripHtml("a<br>b"), "a\nb");
    eq("⭐ stripHtml xử lý &apos; (từng lọt vào bảng cụm từ như một từ thật)",
        pc.stripHtml("<div>don&apos;t worry</div>"), "don't worry");
    eq("stripHtml xử lý thực thể dạng số", pc.stripHtml("it&#39;s ok"), "it's ok");
    eq("stripHtml xử lý thực thể hex", pc.stripHtml("it&#x27;s ok"), "it's ok");

    // Nhận ngôn ngữ theo bảng chữ cái
    eq("Nhận tiếng Ả Rập", ca.detectLang("كم السعر؟"), "ar");
    eq("Nhận tiếng Anh", ca.detectLang("How much are the dentures?"), "latin");
    eq("Nhận tiếng Nhật", ca.detectLang("いくらですか"), "ja");
    eq("Nhận tiếng Việt (dấu)", ca.detectLang("giá bao nhiêu vậy"), "vi");
    eq("Chuỗi rỗng → không rõ", ca.detectLang("   "), "unknown");

    // Rút giá
    eq("Giá dạng '100 SAR'", ca.extractPrices("only 100 SAR today"), [{ amount: 100, currency: "SAR" }]);
    eq("Giá dạng 'SAR 100'", ca.extractPrices("SAR 100 for both"), [{ amount: 100, currency: "SAR" }]);
    eq("Giá tiếng Ả Rập", ca.extractPrices("100 ريال فقط"), [{ amount: 100, currency: "ريال" }]);
    eq("Bỏ qua số không có đơn vị tiền", ca.extractPrices("call me at 0501234567"), []);

    // Số điện thoại
    eq("Nhận số điện thoại Ả Rập Xê Út", ca.looksLikePhone("0501764432"), true);
    eq("Không nhận số quá ngắn", ca.looksLikePhone("100 SAR"), false);

    // ⭐ Ranh giới từ tiếng Ả Rập — lỗi thật tìm được khi đọc kết quả trên dữ liệu sống
    const store = ca.OBJECTION_GROUPS.find((g) => g.key === "store")!;
    eq("⭐ 'محلول' (dung dịch) KHÔNG bị nhận là 'محل' (cửa hàng)", store.re.test("هل يحتاج لمحلول"), false);
    eq("…'محل' đứng riêng vẫn nhận đúng", store.re.test("عندكم محل"), true);
    eq("…⭐ 'المحل' (có mạo từ ال) vẫn nhận đúng", store.re.test("وين المحل"), true);
    eq("…'للمحل' (tiền tố لل) vẫn nhận đúng", store.re.test("رايح للمحل"), true);
    eq("…'لمحلول' (cho dung dịch) vẫn KHÔNG khớp", store.re.test("احتاج لمحلول"), false);
    eq("…và 'فرع' (chi nhánh) vẫn nhận đúng", store.re.test("هل لديكم فرع"), true);

    const scam = ca.OBJECTION_GROUPS.find((g) => g.key === "scam")!;
    eq("Bắt được 'scam'", scam.re.test("this page is a scam"), true);
    eq("Bắt được 'نصابين'", scam.re.test("نصابين"), true);
    eq("Không bắt nhầm 'scamper'", scam.re.test("the scamper ran"), false);

    // Cụm từ hay gặp
    const phrases = ca.topPhrases(
        ["How much are the dentures?", "how much dentures", "How much?", "where is your shop"],
        { minCount: 2, limit: 5 });
    check("Tìm ra cụm 'much' xuất hiện 3 lần", phrases.some((p) => p.phrase.includes("much") && p.count === 3));
    check("Bỏ từ vô nghĩa (the/are/is)", !phrases.some((p) => p.phrase === "the" || p.phrase === "are"));

    // Phân tích một hội thoại giả lập đầy đủ
    const PAGE = "PAGE_X";
    const caConv = ca.analyzeConversation([
        { fromPage: false, senderName: "Ali", text: "How much are the dentures?", at: null, adText: "Quảng cáo NESLEMY" },
        { fromPage: true,  senderName: "Page", text: "100 SAR for upper and lower dentures", at: null, adText: null },
        { fromPage: false, senderName: "Ali", text: "is it a scam?", at: null, adText: null },
        { fromPage: true,  senderName: "Page", text: "Please send your full name, phone and address", at: null, adText: null },
        { fromPage: false, senderName: "Ali", text: "Ali Hassan 0501234567 Riyadh", at: null, adText: null },
    ]);
    eq("Đếm đúng tin của khách", caConv.customerMessages.length, 3);
    eq("Đếm đúng tin của page", caConv.pageMessages.length, 2);
    eq("Câu mở lời của khách", caConv.firstCustomerMessage, "How much are the dentures?");
    eq("Nhận ra khách đã để lại SĐT", caConv.gavePhone, true);
    eq("⭐ Bắt đúng câu page nói NGAY TRƯỚC khi khách đưa số",
        caConv.lineBeforePhone, "Please send your full name, phone and address");
    eq("Khách hỏi giá ngay lượt đầu", caConv.priceAskedAtTurn, 1);
    eq("Rút được giá từ lời page", caConv.prices, [{ amount: 100, currency: "SAR" }]);
    eq("Lấy được nội dung quảng cáo", caConv.adText, "Quảng cáo NESLEMY");

    const caRep = ca.buildReport([caConv]);
    eq("Báo cáo: 1 hội thoại có khách nhắn", caRep.withCustomerMessage, 1);
    eq("Báo cáo: tỉ lệ để lại SĐT 100%", caRep.phoneRate, 1);
    check("Báo cáo bắt được vấn đề 'nghi lừa đảo'", caRep.objections.some((o) => o.key === "scam" && o.count === 1));
    check("Báo cáo có trích dẫn thật kèm theo",
        (caRep.objections.find((o) => o.key === "scam")?.samples[0] ?? "").includes("scam"));
    eq("Báo cáo: giá hay báo nhất", caRep.prices[0], { currency: "SAR", amount: 100, count: 1 });

    await closePool();
} catch (err) {
    failed++;
    failures.push(`Ngoại lệ: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    console.error("\n💥 Ngoại lệ:", err instanceof Error ? err.message : err);
} finally {
    await pg.stop().catch(() => {});
    rmSync(DATA_DIR, { recursive: true, force: true });
}

console.log(`\n${"═".repeat(60)}`);
console.log(failed === 0 ? `✅ ${passed} kiểm tra đều đạt` : `❌ ${failed} lỗi / ${passed + failed} kiểm tra`);
for (const f of failures) console.log(`   • ${f}`);
console.log();
process.exit(failed === 0 ? 0 : 1);
