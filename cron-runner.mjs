// ─── Local cron runner ─────────────────────────────────────────────────────────
// Thay cho Vercel Cron khi chạy local: cứ mỗi 15 phút gọi endpoint /api/broadcast/cron
// để app kiểm tra & bắn các lịch tới giờ. Chạy qua pm2 (xem README bên dưới).
import fs from "fs";

// pm2 chạy node thẳng nên KHÔNG tự load .env.local → tự đọc để lấy secret
function loadEnvLocal() {
    try {
        const txt = fs.readFileSync(new URL("./.env.local", import.meta.url), "utf-8");
        for (const line of txt.split("\n")) {
            const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
            // strip dấu nháy bao quanh để khớp cách Next.js (dotenv) đọc giá trị
            if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
        }
    } catch { /* không có .env.local cũng không sao */ }
}
loadEnvLocal();

const CRON_URL = process.env.CRON_URL || "http://localhost:3001/api/broadcast/cron";
const INTERVAL_MS = Number(process.env.CRON_INTERVAL_MS || 15 * 60 * 1000); // 15 phút

// Gửi kèm secret/key nếu server bật auth — trước đây không gửi nên khi đặt
// CRON_SECRET là cron bị 401 và lịch chết ngầm
function authHeaders() {
    const h = {};
    if (process.env.CRON_SECRET) h["Authorization"] = `Bearer ${process.env.CRON_SECRET}`;
    if (process.env.APP_ACCESS_KEY) h["x-app-key"] = process.env.APP_ACCESS_KEY;
    return h;
}

async function tick() {
    const ts = new Date().toISOString();
    try {
        const res = await fetch(CRON_URL, { headers: authHeaders() });
        const d = await res.json().catch(() => ({}));
        if (res.status === 401) {
            console.log(`${ts} | cron tick 401 UNAUTHORIZED — kiểm tra CRON_SECRET/APP_ACCESS_KEY trong .env.local`);
            return;
        }
        console.log(`${ts} | cron tick → fired=${d.fired ?? "?"} | ${d.message ?? res.status}`);
    } catch (e) {
        console.log(`${ts} | cron tick LỖI: ${e instanceof Error ? e.message : e}`);
    }
}

console.log(`[cron-runner] Bắt đầu — gọi ${CRON_URL} mỗi ${INTERVAL_MS / 60000} phút`);
tick();
setInterval(tick, INTERVAL_MS);
