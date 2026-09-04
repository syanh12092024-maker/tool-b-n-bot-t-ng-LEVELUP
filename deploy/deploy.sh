#!/usr/bin/env bash
# Đẩy bản mới lên VPS. Dùng SSH key sẵn có (host "talpha-server" trong ~/.ssh/config).
#
#   bash deploy/deploy.sh
#
# KHÔNG đụng tới .env và config/pos-shops.json trên server — hai file đó chứa
# bí mật, chỉ sửa trực tiếp trên server.
set -euo pipefail
cd "$(dirname "$0")/.."

HOST=${BANBOT_HOST:-talpha-server}
DIR=${BANBOT_DIR:-/opt/banbot}

echo "▶ Kiểm tra trước khi đẩy…"
npx tsc --noEmit
npm run test:smoke

echo "▶ Biên dịch…"
npm run build

echo "▶ Đẩy engine lên $HOST:$DIR…"
rsync -az --delete ./dist "$HOST:$DIR/"
rsync -az ./migrations ./kich-ban ./deploy ./package.json ./package-lock.json ./ecosystem.config.cjs ./README.md "$HOST:$DIR/"

echo "▶ Đẩy giao diện…"
# KHÔNG đụng .env.local trên server — chứa mật khẩu và chuỗi kết nối
rsync -az --delete --exclude node_modules --exclude .next --exclude .env.local ./web "$HOST:$DIR/"

echo "▶ Cài gói + migrate + build giao diện + khởi động lại…"
ssh "$HOST" "cd $DIR \
  && npm ci --omit=dev --silent \
  && node dist/db/migrate.js \
  && cd web && npm ci --omit=dev --silent && npm run build \
  && cd $DIR \
  && pm2 restart banbot-web banbot-webhook banbot-ui --update-env \
  && pm2 save >/dev/null"

# CẢNH BÁO: pm2 restart KHÔNG nạp lại cron_restart. Đổi lịch trong
# ecosystem.config.cjs thì phải XOÁ rồi TẠO LẠI tiến trình, không thì pm2 vẫn
# chạy lịch cũ mà không báo gì. Từng mất một lúc mới phát hiện job send vẫn
# chạy 5 phút/lần trong khi cấu hình đã đổi thành mỗi phút.
if [ "${RELOAD_CRON:-0}" = "1" ]; then
  echo "▶ Nạp lại lịch cho các job theo cron…"
  ssh "$HOST" "cd $DIR \
    && pm2 delete banbot-send banbot-sync banbot-pos banbot-health >/dev/null 2>&1
    pm2 start ecosystem.config.cjs --only banbot-send,banbot-sync,banbot-pos,banbot-health >/dev/null \
    && pm2 save >/dev/null && echo '  đã nạp lịch mới'"
fi

echo "▶ Kiểm tra còn sống…"
ssh "$HOST" "curl -sf -o /dev/null -w 'dashboard → HTTP %{http_code}\n' http://127.0.0.1:3110/healthz
             curl -sf -o /dev/null -w 'giao diện → HTTP %{http_code}\n' http://127.0.0.1:3112/"

echo "✅ Xong → https://$(ssh -G \"$HOST\" | awk '/^hostname /{print $2}'):8446"
