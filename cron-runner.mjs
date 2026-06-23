// ─── Local cron runner ─────────────────────────────────────────────────────────
// Thay cho Vercel Cron khi chạy local: cứ mỗi 15 phút gọi endpoint /api/broadcast/cron
// để app kiểm tra & bắn các lịch tới giờ. Chạy qua pm2 (xem README bên dưới).
const CRON_URL = process.env.CRON_URL || "http://localhost:3001/api/broadcast/cron";
const INTERVAL_MS = Number(process.env.CRON_INTERVAL_MS || 15 * 60 * 1000); // 15 phút

async function tick() {
    const ts = new Date().toISOString();
    try {
        const res = await fetch(CRON_URL);
        const d = await res.json().catch(() => ({}));
        console.log(`${ts} | cron tick → fired=${d.fired ?? "?"} | ${d.message ?? res.status}`);
    } catch (e) {
        console.log(`${ts} | cron tick LỖI: ${e instanceof Error ? e.message : e}`);
    }
}

console.log(`[cron-runner] Bắt đầu — gọi ${CRON_URL} mỗi ${INTERVAL_MS / 60000} phút`);
tick();
setInterval(tick, INTERVAL_MS);
