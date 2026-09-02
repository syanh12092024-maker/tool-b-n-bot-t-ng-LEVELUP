import { parseArgs } from "node:util";
import { closePool } from "../db/pool.js";
import { config } from "../config/index.js";
import { MARKETS, MARKET_KEYS, isMarketKey } from "../config/markets.js";
import * as pancake from "../clients/pancake.js";
import * as pagesRepo from "../db/repositories/pages.repo.js";

/**
 * npm run page:add -- --page <id> --market <Saudi|UAE|…> [--name "…"] [--shop <id>] [--offset <n>] [--activate]
 *
 * Đưa một page vào hệ thống. Chưa bật gửi ngay (trừ khi --activate) — nên
 * nạp kịch bản (npm run script:seed) và chạy sync một lần trước khi bật.
 */

const USAGE = `
Cách dùng:
  npm run page:add -- --page 123456789 --market Saudi
  npm run page:add -- --page 123456789 --market Japan --name "Talpha JP" --shop 987
  npm run page:add -- --page 123456789 --offset 7 --market Thailand    (thị trường lạ → khai múi giờ tay)

Thị trường có sẵn: ${MARKET_KEYS.join(", ")}
`;

async function main(): Promise<void> {
    const { values } = parseArgs({
        options: {
            page: { type: "string" },
            market: { type: "string" },
            name: { type: "string" },
            shop: { type: "string" },
            offset: { type: "string" },
            activate: { type: "boolean", default: false },
            help: { type: "boolean", short: "h", default: false },
        },
    });

    if (values.help || !values.page || !values.market) {
        console.log(USAGE);
        process.exitCode = values.help ? 0 : 1;
        return;
    }

    const pageId = values.page.trim();
    const market = values.market.trim();

    let utcOffset: number;
    if (values.offset !== undefined) {
        utcOffset = Number(values.offset);
        if (!Number.isInteger(utcOffset) || utcOffset < -12 || utcOffset > 14) {
            throw new Error(`--offset phải là số nguyên từ -12 đến 14, nhận được "${values.offset}"`);
        }
    } else if (isMarketKey(market)) {
        utcOffset = MARKETS[market].utcOffset;
    } else {
        throw new Error(`Không biết thị trường "${market}". Dùng một trong: ${MARKET_KEYS.join(", ")} — hoặc thêm --offset <giờ>.`);
    }

    // Lấy tên từ Pancake nếu không truyền
    let pageName = values.name?.trim() ?? "";
    const pancakePages = await pancake.listPages().catch(() => []);
    const found = pancakePages.find((p) => p.pageId === pageId);
    if (!pageName) pageName = found?.name ?? `Page ${pageId}`;

    if (!found) {
        console.log(`⚠️  Pancake không nhìn thấy page ${pageId} với token hiện tại. Vẫn thêm, nhưng sync sẽ không lấy được khách.`);
    } else if (!found.hasToken) {
        console.log(`⚠️  Page ${pageId} có trong Pancake nhưng chưa có page_access_token — sync sẽ thử tạo token lúc chạy.`);
    }

    const page = await pagesRepo.upsert({ pageId, pageName, market, utcOffset, pancakeShopId: values.shop ?? null });

    if (values.activate) {
        await pagesRepo.setActive(page.id, true, config.rampUp.startPercent);
    }

    const tz = utcOffset >= 0 ? `UTC+${utcOffset}` : `UTC${utcOffset}`;
    console.log(`\n✅ Đã lưu page`);
    console.log(`   id hệ thống : ${page.id}`);
    console.log(`   page id     : ${page.page_id}`);
    console.log(`   tên         : ${page.page_name}`);
    console.log(`   thị trường  : ${market} (${tz}) → bắn lúc ${config.journey.slotHours.map((h) => h + "h").join(", ")} giờ địa phương`);
    console.log(`   trạng thái  : ${values.activate ? "ĐANG BẬT (khởi động dần từ " + config.rampUp.startPercent + "%)" : "chưa bật"}`);
    if (!values.activate) {
        console.log(`\n   Bước tiếp: npm run script:seed -- --page ${pageId} --file kich-ban.json`);
        console.log(`             npm run job:sync -- --page ${pageId}`);
        console.log(`             npm run page:add -- --page ${pageId} --market ${market} --activate`);
    }
    console.log();
}

main()
    .catch((err) => {
        console.error("\n❌", err instanceof Error ? err.message : err, "\n");
        process.exitCode = 1;
    })
    .finally(() => closePool());
