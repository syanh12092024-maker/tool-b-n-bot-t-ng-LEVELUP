import type { Logger } from "pino";
import { config } from "../config/index.js";
import { localDateStr, localSlotToUtc, localDaysBetween, isWithinSendWindow } from "../lib/time.js";
import { runJob, withJobRun, isMain } from "../lib/runner.js";
import { messageIndexFor } from "../domain/journey.js";
import type { Page } from "../domain/types.js";
import * as pagesRepo from "../db/repositories/pages.repo.js";
import * as scriptsRepo from "../db/repositories/scripts.repo.js";
import * as customersRepo from "../db/repositories/customers.repo.js";
import * as queueRepo from "../db/repositories/queue.repo.js";

/**
 * JOB PLAN — xếp hàng đợi gửi cho HÔM NAY (theo ngày địa phương của page).
 *
 * Với mỗi khách active trong hành trình, sinh một dòng cho mỗi khung giờ còn
 * chưa qua. Nội dung chọn theo công thức xoay vòng. Lượt đã có (chạy lại trong
 * ngày) bị UNIQUE bỏ qua — chạy PLAN bao nhiêu lần cũng không xếp trùng.
 *
 * Thường được SYNC gọi ngay sau khi đồng bộ xong; cũng chạy độc lập được:
 *   npm run job:plan -- --page <id>
 */

export interface PlanStats extends Record<string, unknown> {
    customers: number;
    eligible: number;
    rampPercent: number;
    enqueued: number;
    slotsSkippedPast: number;
    skippedOutOfWindow: number;
}

/** Phần trăm tệp được gửi hôm nay theo lịch khởi động dần. */
export function rampPercentFor(page: Page, now: Date = new Date()): number {
    if (!page.activated_at) return 100;
    const days = localDaysBetween(page.activated_at, now, page.utc_offset);
    const { days: rampDays, startPercent } = config.rampUp;
    if (rampDays <= 0 || days >= rampDays) return 100;
    return Math.round(startPercent + ((100 - startPercent) * days) / rampDays);
}

export async function planPage(page: Page, log: Logger, opts: { dryRun?: boolean } = {}): Promise<PlanStats> {
    const stats: PlanStats = { customers: 0, eligible: 0, rampPercent: 100, enqueued: 0, slotsSkippedPast: 0, skippedOutOfWindow: 0 };
    const now = new Date();

    const script = await scriptsRepo.activeScriptForPage(page.id);
    if (!script) {
        log.warn("Page chưa có kịch bản đang bật — bỏ qua. Nạp bằng: npm run script:seed");
        return stats;
    }
    const messages = await scriptsRepo.messagesForScript(script.id);
    if (messages.length === 0) {
        log.warn({ scriptId: script.id }, "Kịch bản không có nội dung — bỏ qua");
        return stats;
    }
    if (messages.length !== script.message_count) {
        log.warn({ inDb: messages.length, declared: script.message_count }, "Số nội dung không khớp khai báo — dùng số thật trong DB");
    }

    // Khởi động dần
    stats.rampPercent = rampPercentFor(page, now);
    if (stats.rampPercent !== page.ramp_percent && !opts.dryRun) {
        await pagesRepo.setRampPercent(page.id, stats.rampPercent);
    }

    const all = await customersRepo.listForPlanning(page.id, script.journey_days);
    stats.customers = all.length;

    // Chọn tập con XÁC ĐỊNH theo id để cùng những khách đó được tiếp tục hôm sau,
    // không phải mỗi ngày một nhóm ngẫu nhiên khác
    const eligible = all.filter((c) => {
        if (stats.rampPercent < 100 && c.id % 100 >= stats.rampPercent) return false;
        if (!isWithinSendWindow(c.last_interaction_at, config.journey.windowDays, now)) {
            stats.skippedOutOfWindow++;
            return false;
        }
        return true;
    });
    stats.eligible = eligible.length;

    const today = localDateStr(page.utc_offset, now);
    const slotHours = config.journey.slotHours.slice(0, script.slots_per_day);
    const lateCutoffMs = now.getTime() - config.send.lateWindowMin * 60_000;

    // Giờ UTC thật của từng khung giờ hôm nay — tính một lần cho cả page
    const slotTimes = slotHours.map((hour) => localSlotToUtc(today, hour, page.utc_offset));

    const rows: queueRepo.EnqueueRow[] = [];
    for (const c of eligible) {
        for (let slotIndex = 0; slotIndex < slotTimes.length; slotIndex++) {
            const scheduledAt = slotTimes[slotIndex];
            if (!scheduledAt) continue;
            if (scheduledAt.getTime() < lateCutoffMs) {
                stats.slotsSkippedPast++;
                continue; // khung giờ này đã trôi qua quá lâu, không xếp
            }
            const msgIdx = messageIndexFor(c.journey_day, slotIndex, script.slots_per_day, messages.length);
            const msg = messages[msgIdx];
            if (!msg) continue;
            rows.push({
                customerId: c.id,
                pageDbId: page.id,
                scriptMessageId: msg.id,
                journeyDay: c.journey_day,
                slotIndex,
                scheduledAt,
            });
        }
    }

    if (opts.dryRun) {
        stats.enqueued = rows.length;
        log.info({ ...stats, dryRun: true }, "Sẽ xếp (chưa ghi)");
        return stats;
    }

    const CHUNK = 1000;
    for (let i = 0; i < rows.length; i += CHUNK) {
        stats.enqueued += await queueRepo.enqueueBatch(rows.slice(i, i + CHUNK));
    }
    await pagesRepo.markPlanned(page.id);

    log.info(
        { ...stats, today, slots: slotHours.map((h) => `${h}h`).join(",") },
        `Đã xếp ${stats.enqueued} lượt cho ${stats.eligible} khách`
    );
    return stats;
}

// ─── Chạy độc lập ─────────────────────────────────────────────────────────────
if (isMain(import.meta.url)) {
    runJob("plan", async (args, log) => {
        const pages = args.page
            ? [await pagesRepo.findByFbPageId(args.page)].filter((p): p is Page => p !== null)
            : await pagesRepo.listActive();

        if (pages.length === 0) {
            log.warn(args.page ? `Không tìm thấy page ${args.page}` : "Không có page nào đang bật");
            return;
        }

        for (const page of pages) {
            const plog = log.child({ pageId: page.page_id, page: page.page_name });
            if (!page.is_active && !args.force) {
                plog.info("Page chưa bật — dùng --force nếu vẫn muốn xếp hàng đợi");
                continue;
            }
            await withJobRun("plan", page.id, plog, () => planPage(page, plog, { dryRun: args.dryRun })).catch(() => {});
        }
    });
}
