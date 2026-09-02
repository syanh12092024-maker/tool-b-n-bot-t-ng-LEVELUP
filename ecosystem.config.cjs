/**
 * pm2 — một công cụ chạy cả 4 job, không cần crontab riêng.
 *
 *   npm run build            # biên dịch ra dist/ trước
 *   pm2 start ecosystem.config.cjs
 *   pm2 save && pm2 startup  # tự chạy lại khi VPS khởi động
 *
 * Job theo lịch dùng cron_restart + autorestart:false: pm2 khởi động tiến trình
 * đúng giờ, tiến trình chạy xong tự thoát, pm2 không kéo lại cho tới mốc sau.
 */
const cwd = __dirname;

module.exports = {
    apps: [
        {
            // Nhận webhook: chạy liên tục, sập thì kéo lại
            name: "banbot-webhook",
            script: "dist/jobs/webhook.js",
            cwd,
            autorestart: true,
            max_restarts: 50,
            restart_delay: 3000,
            env: { NODE_ENV: "production" },
        },
        {
            // Gửi: mỗi 5 phút một lượt, mỗi lượt tự giới hạn 4,5 phút
            name: "banbot-send",
            script: "dist/jobs/send.js",
            cwd,
            autorestart: false,
            cron_restart: "*/5 * * * *",
            env: { NODE_ENV: "production" },
        },
        {
            // Đồng bộ tệp khách: gọi mỗi giờ, job tự chọn page nào đang ở 3h sáng giờ địa phương
            name: "banbot-sync",
            script: "dist/jobs/sync.js",
            cwd,
            autorestart: false,
            cron_restart: "5 * * * *",
            env: { NODE_ENV: "production" },
        },
        {
            // Giám sát sức khoẻ page: mỗi 15 phút
            name: "banbot-health",
            script: "dist/jobs/health.js",
            cwd,
            autorestart: false,
            cron_restart: "2,17,32,47 * * * *",
            env: { NODE_ENV: "production" },
        },
    ],
};
