import * as pancake from "../clients/pancake.js";
import * as facebook from "../clients/facebook.js";
import * as pos from "../clients/pos.js";

/**
 * npm run check:tokens — token Pancake và Facebook còn sống không.
 * Chạy trước khi bật bất kỳ page nào; chạy lại mỗi khi thấy gửi lỗi hàng loạt.
 */

async function main(): Promise<void> {
    console.log("\n🔑 Kiểm tra token…\n");

    const p = await pancake.ping();
    if (p.ok) console.log(`✅ Pancake CRM      — nhìn thấy ${p.pageCount} page`);
    else console.log(`❌ Pancake CRM      — ${p.error ?? "không lấy được danh sách page"}\n   → Token hết hạn? Đăng nhập lại Pancake và cập nhật PANCAKE_CRM_TOKEN.`);

    const f = await facebook.ping();
    if (!f.enabled) console.log(`⚪ Facebook Graph   — chưa cấu hình (đường dự phòng sẽ tắt)`);
    else if (f.ok) console.log(`✅ Facebook Graph   — có token cho ${f.pageCount} page`);
    else console.log(`❌ Facebook Graph   — ${f.error ?? "không lấy được page nào"}\n   → Token user hết hạn hoặc thiếu quyền pages_messaging.`);

    const shops = pos.loadShops();
    if (shops.length === 0) {
        console.log(`⚪ Pancake POS      — chưa cấu hình (đối chiếu đơn tự động sẽ tắt)`);
        console.log(`                     → chép config/pos-shops.example.json thành config/pos-shops.json`);
    } else {
        for (const shop of shops) {
            const r = await pos.ping(shop);
            if (r.ok) console.log(`✅ POS ${shop.name.padEnd(12)} — khoá dùng được (shop ${shop.shop_id})`);
            else console.log(`❌ POS ${shop.name.padEnd(12)} — ${r.error ?? "không đọc được danh sách khách"}`);
        }
    }

    console.log();
    if (!p.ok) process.exitCode = 1;
}

main().catch((err) => {
    console.error("❌", err instanceof Error ? err.message : err);
    process.exitCode = 1;
});
