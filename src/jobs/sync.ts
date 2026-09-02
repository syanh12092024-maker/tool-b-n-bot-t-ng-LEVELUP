import type { Logger } from "pino";
import { config } from "../config/index.js";
import { localDateStr, localHourDecimal } from "../lib/time.js";
import { runJob, withJobRun, isMain } from "../lib/runner.js";
import { PURCHASE_TAGS } from "../domain/rules.js";
import type { Page } from "../domain/types.js";
import * as pancake from "../clients/pancake.js";
import * as pagesRepo from "../db/repositories/pages.repo.js";
import * as customersRepo from "../db/repositories/customers.repo.js";
import * as queueRepo from "../db/repositories/queue.repo.js";
import { planPage } from "./plan.js";

/**
 * JOB SYNC — làm mới tệp khách của một page từ Pancake, rồi gọi PLAN xếp hàng đợi hôm nay.
 *
 * Lịch chạy: cron gọi mỗi GIỜ (`npm run job:sync`). Job tự chọn page nào đang ở
 * đúng giờ SYNC_HOUR_LOCAL theo múi giờ riêng của page và chưa đồng bộ hôm nay.
 * Vì thế một dòng cron duy nhất phục vụ được cả Riyadh (+3) lẫn Tokyo (+9).
 *
 * Chạy tay cho một page (bỏ qua kiểm tra giờ):  npm run job:sync -- --page <id>
 * Chạy tay cho mọi page đang bật:              npm run job:sync -- --force
 */

export interface SyncStats extends Record<string, unknown> {
    scanned: number;
    windows: number;
    hitCap: boolean;
    inserted: number;
    rejoined: number;
    updated: number;
    optedOut: number;
    convertedByTag: number;
    expiredOutOfWindow: number;
    expiredJourneyDone: number;
    planned: number;
}

/** Page này có tới giờ đồng bộ chưa? */
export function isDueForSync(page: Page, now: Date = new Date()): boolean {
    const hourNow = Math.floor(localHourDecimal(page.utc_offset, now));
    if (hourNow !== config.sync.hourLocal) return false;
    if (!page.last_synced_at) return true;
    return localDateStr(page.utc_offset, page.last_synced_at) !== localDateStr(page.utc_offset, now);
}

export async function syncPage(page: Page, log: Logger, opts: { dryRun?: boolean; skipPlan?: boolean } = {}): Promise<SyncStats> {
    const stats: SyncStats = {
        scanned: 0, windows: 0, hitCap: false,
        inserted: 0, rejoined: 0, updated: 0,
        optedOut: 0, convertedByTag: 0,
        expiredOutOfWindow: 0, expiredJourneyDone: 0,
        planned: 0,
    };

    // 1. Quét hội thoại từ Pancake
    log.info("Bắt đầu quét hội thoại từ Pancake…");
    const scan = await pancake.scanConversations(page.page_id, {
        onProgress: (found, window) => {
            if (window % 6 === 0) log.debug({ found, window }, "…đang quét");
        },
    });
    stats.scanned = scan.customers.length;
    stats.windows = scan.windowsScanned;
    stats.hitCap = scan.hitCap;
    log.info({ scanned: stats.scanned, windows: stats.windows, hitCap: stats.hitCap }, "Quét xong");

    if (opts.dryRun) {
        log.info({ ...stats, dryRun: true }, "Dry-run: không ghi gì");
        return stats;
    }

    // 2. Ghi vào tệp khách theo lô
    const CHUNK = 500;
    for (let i = 0; i < scan.customers.length; i += CHUNK) {
        const r = await customersRepo.upsertBatch(page.id, scan.customers.slice(i, i + CHUNK));
        stats.inserted += r.inserted;
        stats.rejoined += r.rejoined;
        stats.updated += r.updated;
        await customersRepo.recordEvents(page.id, r.insertedIds, "entered");
        await customersRepo.recordEvents(page.id, r.rejoinedIds, "restarted");
    }

    // 3. Danh sách chặn luôn thắng
    stats.optedOut = await customersRepo.enforceOptOuts(page.id);

    // 4. Tag mua hàng → converted, huỷ lượt còn chờ
    const converted = await customersRepo.convertByPurchaseTags(
        page.id,
        PURCHASE_TAGS.map((t) => `%${t.toLowerCase()}%`)
    );
    stats.convertedByTag = converted.length;
    for (const id of converted) {
        await queueRepo.cancelPendingForCustomer(id, "Khách đã mua (tag)");
    }
    await customersRepo.recordEvents(page.id, converted, "ordered");

    // 5. Tính lại ngày thứ N rồi loại khách hết hạn
    await customersRepo.recomputeJourneyDays(page.id, page.utc_offset);
    const expired = await customersRepo.expireCustomers(page.id, config.journey.windowDays, config.journey.days);
    stats.expiredOutOfWindow = expired.outOfWindow;
    stats.expiredJourneyDone = expired.journeyDone;

    await pagesRepo.markSynced(page.id);

    const cs = await customersRepo.stats(page.id);
    log.info(
        {
            inserted: stats.inserted, rejoined: stats.rejoined, updated: stats.updated,
            convertedByTag: stats.convertedByTag, optedOut: stats.optedOut,
            expired: stats.expiredOutOfWindow + stats.expiredJourneyDone,
            active: cs.active, total: cs.total, byDay: cs.byDay,
        },
        `Tệp khách: ${cs.active} active / ${cs.total} tổng`
    );

    // 6. Xếp hàng đợi hôm nay (chỉ khi page đang bật)
    if (!opts.skipPlan && page.is_active) {
        const p = await planPage(page, log.child({ job: "plan" }));
        stats.planned = p.enqueued;
    }

    return stats;
}

// ─── Chạy độc lập ─────────────────────────────────────────────────────────────
if (isMain(import.meta.url)) {
    runJob("sync", async (args, log) => {
        const now = new Date();

        let pages: Page[];
        if (args.page) {
            const p = await pagesRepo.findByFbPageId(args.page);
            if (!p) {
                log.error(`Không tìm thấy page ${args.page} — thêm bằng npm run page:add`);
                process.exitCode = 1;
                return;
            }
            pages = [p]; // chỉ định page cụ thể = luôn chạy, bất kể giờ
        } else {
            const active = await pagesRepo.listActive();
            pages = args.force ? active : active.filter((p) => isDueForSync(p, now));
            if (pages.length === 0) {
                log.info(
                    { activePages: active.length, syncHourLocal: config.sync.hourLocal },
                    "Không có page nào tới giờ đồng bộ"
                );
                return;
            }
        }

        let ok = 0;
        for (const page of pages) {
            const plog = log.child({ pageId: page.page_id, page: page.page_name, tz: `UTC${page.utc_offset >= 0 ? "+" : ""}${page.utc_offset}` });
            try {
                await withJobRun("sync", page.id, plog, () => syncPage(page, plog, { dryRun: args.dryRun }));
                ok++;
            } catch {
                /* đã log trong withJobRun — sang page tiếp theo */
            }
        }
        log.info({ ok, total: pages.length }, "SYNC xong");
    });
}
