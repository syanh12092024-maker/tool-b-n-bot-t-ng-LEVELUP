// Cấu hình pm2 cho web broadcast (cổng 3001).
// Chạy thẳng binary `next` (KHÔNG qua `npm start`) để tránh lỗi
// `EPERM uv_cwd` của npm khi pm2 resurrect lúc máy khởi động lại.
module.exports = {
  apps: [
    {
      name: 'talpha-broadcast',
      script: './node_modules/next/dist/bin/next',
      args: 'start -p 3001',
      cwd: '/Users/syanh/Desktop/Bắn bot AI/app',
      interpreter: '/Users/syanh/.nvm/versions/node/v20.20.2/bin/node',
      autorestart: true,
      max_restarts: 20,
    },
  ],
};
