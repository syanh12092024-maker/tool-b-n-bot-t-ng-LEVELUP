import { config } from "../config/index.js";
import { floorToMinutes } from "../lib/time.js";
import { runJob, withJobRun } from "../lib/runner.js";
import * as pagesRepo from "../db/repositories/pages.repo.js";
import * as healthRepo from "../db/repositories/health.repo.js";

/**
 * JOB HEALTH — tầng bảo vệ cho mức 4 tin/ngày. Cron mỗi 15 phút.
 *
 * Đọc send_log 60 phút gần nhất của từng page và quyết định:
 *   - có lỗi cấp page (#2022 / 121) mà chưa ngưng → ngưng
 *     (job SEND đã ngưng ngay lúc gặp; đây là lớp kiểm tra lại)
 *   - tỉ lệ lỗi > ngưỡng và đủ mẫu → 'degraded' (lô nhỏ hơn, nghỉ lâu hơn)
 *   - đang 'degraded' mà tỉ lệ lỗi đã xuống dưới nửa ngưỡng → 'ok'
 *   - bị ngưng nhiều lần trong 24h → lần ngưng tiếp theo kéo dài hơn hẳn
 *
 * Mỗi lần chạy ghi một ảnh chụp vào page_health để dashboard vẽ biểu đồ.
 */

interface HealthStats extends Record<string, unknown> {
    pages: number;
    paused: number;
    degraded: number;
    recovered: number;
    released: number;
}

runJob("health", async (args, log) => {
    await withJobRun("health", undefined, log, async () => {
        const stats: HealthStats = { pages: 0, paused: 0, degraded: 0, recovered: 0, released: 0 };
        const now = new Date();
        const windowStart = floorToMinutes(now, 15);

        // Hết hạn ngưng → cho chạy lại (thận trọng)
        const released = await pagesRepo.releaseExpiredPauses();
        stats.released = released.length;

        // Đầu ngày UTC: reset bộ đếm ngưng 24h
        if (now.getUTCHours() === 0 && now.getUTCMinutes() < 15) {
            await pagesRepo.resetPauseCounters();
        }

        const pages = args.page
            ? [await pagesRepo.findByFbPageId(args.page)].filter((p) => p !== null)
            : await pagesRepo.listActive();

        for (const page of pages) {
            if (!page) continue;
            stats.pages++;
            const plog = log.child({ pageId: page.page_id, page: page.page_name });
            const s = await healthRepo.statsLastMinutes(page.id, 60);
            let action: string | null = null;

            const hasPageLevelError = s.error2022 > 0 || s.error121 > 0;
            const enoughSample = s.total >= config.health.minSample;

            if (hasPageLevelError && page.health_state !== "paused") {
                // Leo thang: ngưng nhiều lần trong ngày → lần này ngưng dài
                const escalate = page.pause_count_24h + 1 >= config.health.escalateAfterPauses;
                const minutes = escalate ? config.health.escalateHours * 60 : config.health.pauseMinutes;
                const why = s.error2022 > 0 ? `Facebook chặn page (#2022 ×${s.error2022})` : `Pancake hết gói cước (121 ×${s.error121})`;
                await pagesRepo.pause(page.id, minutes, escalate ? `${why} — lần thứ ${page.pause_count_24h + 1} trong 24h, ngưng ${config.health.escalateHours}h` : why);
                action = escalate ? "escalate" : "pause";
                stats.paused++;
                plog.error({ ...s, minutes }, `⛔ ${action === "escalate" ? "LEO THANG — " : ""}ngưng page ${minutes} phút: ${why}`);
            } else if (page.health_state === "ok" && enoughSample && s.errorRate > config.health.degradeErrorRate) {
                await pagesRepo.degrade(page.id, `Tỉ lệ lỗi ${(s.errorRate * 100).toFixed(0)}% trong 60 phút`);
                action = "degrade";
                stats.degraded++;
                plog.warn({ ...s }, `🟡 Hãm tốc — tỉ lệ lỗi ${(s.errorRate * 100).toFixed(0)}%`);
            } else if (page.health_state === "degraded" && enoughSample && s.errorRate < config.health.degradeErrorRate / 2) {
                await pagesRepo.recover(page.id);
                action = "recover";
                stats.recovered++;
                plog.info({ ...s }, `🟢 Hồi phục — tỉ lệ lỗi ${(s.errorRate * 100).toFixed(0)}%`);
            } else if (!args.dryRun) {
                plog.debug({ ...s, state: page.health_state }, "ổn");
            }

            await healthRepo.insertSnapshot(page.id, windowStart, s, action);
        }

        log.info(stats, "HEALTH xong");
        return stats;
    });
});
