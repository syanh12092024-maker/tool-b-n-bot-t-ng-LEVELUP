import type { Logger } from "pino";
import { runJob, withJobRun, isMain } from "../lib/runner.js";
import type { Page } from "../domain/types.js";
import * as pos from "../clients/pos.js";
import * as pagesRepo from "../db/repositories/pages.repo.js";
import * as customersRepo from "../db/repositories/customers.repo.js";
import * as queueRepo from "../db/repositories/queue.repo.js";

/**
 * JOB POS — đối chiếu đơn hàng, dừng chuỗi cho khách đã chốt. Cron mỗi 15 phút.
 *
 * Vì sao cần: hai đường bắt đơn còn lại đều phụ thuộc con người —
 * webhook /webhook/order cần ai đó nối hệ thống ngoài, tag mua hàng cần nhân
 * viên gắn tay. Cả hai không xảy ra thì khách đã mua vẫn nhận đủ 28 tin: vừa
 * phiền khách, vừa đốt uy tín page. Job này đọc thẳng từ POS nên không cần
 * ai đổi thói quen làm việc.
 *
 * Không có config/pos-shops.json → job thoát ngay, hệ thống chạy bình thường.
 *
 *   npm run job:pos                  đối chiếu mọi page đang bật có gắn shop
 *   npm run job:pos -- --page <id>   một page
 *   npm run job:pos -- --dry-run     chỉ xem, không ghi
 */

const CONVERT_MODE = (process.env.POS_CONVERT_MODE === "any" ? "any" : "increase") as "increase" | "any";

export interface PosStats extends Record<string, unknown> {
    shop: string;
    posCustomers: number;
    pagesFetched: number;
    matched: number;
    baselineSet: number;
    converted: number;
    queueCancelled: number;
}

export async function reconcilePage(
    page: Page,
    shop: pos.PosShop,
    log: Logger,
    opts: { dryRun?: boolean; cache?: Map<string, pos.FetchResult> } = {}
): Promise<PosStats> {
    const stats: PosStats = {
        shop: shop.name, posCustomers: 0, pagesFetched: 0,
        matched: 0, baselineSet: 0, converted: 0, queueCancelled: 0,
    };

    // Một shop phục vụ nhiều page → chỉ gọi POS một lần cho mỗi shop trong lượt chạy
    let result = opts.cache?.get(shop.shop_id);
    if (!result) {
        log.info({ shop: shop.name }, "Đang lấy khách từ POS…");
        result = await pos.fetchCustomers(shop, {
            onProgress: (found, p) => {
                if (p % 20 === 0) log.debug({ found, page: p }, "…đang lấy");
            },
        });
        opts.cache?.set(shop.shop_id, result);
        if (result.hitCap) log.warn({ shop: shop.name }, "Chạm trần số trang POS — có thể còn khách chưa lấy hết");
    }
    stats.pagesFetched = result.pagesFetched;

    // POS trả khách của MỌI page trong shop → lọc đúng page này
    const mine = result.customers.filter((c) => c.pageId === page.page_id);
    stats.posCustomers = mine.length;

    if (mine.length === 0) {
        log.info({ shop: shop.name, posTotal: result.customers.length }, "POS không có khách nào của page này");
        return stats;
    }

    if (opts.dryRun) {
        log.info({ ...stats, dryRun: true }, `POS có ${mine.length} khách của page — dry-run, không ghi`);
        return stats;
    }

    const applied = await customersRepo.applyPosOrders(
        page.id,
        mine.map((c) => ({ psid: c.psid, orderCount: c.orderCount })),
        CONVERT_MODE
    );
    stats.matched = applied.matched;
    stats.baselineSet = applied.baselineSet;
    stats.converted = applied.converted;

    for (const id of applied.convertedIds) {
        stats.queueCancelled += await queueRepo.cancelPendingForCustomer(id, "Đã chốt đơn (POS)");
    }
    await customersRepo.recordEvents(page.id, applied.convertedIds, "ordered");

    if (applied.converted > 0) {
        log.info(
            { converted: applied.converted, queueCancelled: stats.queueCancelled, mode: CONVERT_MODE },
            `🎉 ${applied.converted} khách vừa chốt đơn — đã dừng chuỗi`
        );
    } else {
        log.info(
            { matched: applied.matched, baselineSet: applied.baselineSet, posCustomers: mine.length },
            "Đối chiếu xong, chưa ai chốt đơn mới"
        );
    }
    return stats;
}

if (isMain(import.meta.url)) {
    runJob("pos", async (args, log) => {
        if (!pos.isEnabled()) {
            log.info("POS chưa cấu hình (thiếu config/pos-shops.json) — bỏ qua");
            return;
        }

        const pages = args.page
            ? [await pagesRepo.findByFbPageId(args.page)].filter((p): p is Page => p !== null)
            : await pagesRepo.listActive();

        // Nhiều page dùng chung một shop → gọi POS một lần rồi dùng lại
        const cache = new Map<string, pos.FetchResult>();
        let done = 0;
        let totalConverted = 0;

        for (const page of pages) {
            if (!page.pancake_shop_id) {
                log.debug({ page: page.page_name }, "Page chưa gắn shop POS — bỏ qua");
                continue;
            }
            const shop = pos.findShop(page.pancake_shop_id);
            if (!shop) {
                log.warn(
                    { page: page.page_name, shopId: page.pancake_shop_id },
                    "Page gắn shop POS không có trong config/pos-shops.json"
                );
                continue;
            }

            const plog = log.child({ pageId: page.page_id, page: page.page_name, shop: shop.name });
            try {
                const s = await withJobRun("pos", page.id, plog, () =>
                    reconcilePage(page, shop, plog, { dryRun: args.dryRun, cache })
                );
                totalConverted += Number(s.converted);
                done++;
            } catch {
                /* đã log — sang page tiếp */
            }
        }

        log.info({ pages: done, converted: totalConverted, mode: CONVERT_MODE }, "POS xong");
    });
}
