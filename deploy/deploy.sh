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

echo "▶ Đẩy lên $HOST:$DIR…"
rsync -az --delete ./dist "$HOST:$DIR/"
rsync -az ./migrations ./kich-ban ./deploy ./package.json ./package-lock.json ./ecosystem.config.cjs ./README.md "$HOST:$DIR/"

echo "▶ Cài gói + migrate + khởi động lại…"
ssh "$HOST" "cd $DIR \
  && npm ci --omit=dev --silent \
  && node dist/db/migrate.js \
  && pm2 restart banbot-web banbot-webhook --update-env \
  && pm2 save >/dev/null"

echo "▶ Kiểm tra dashboard còn sống…"
ssh "$HOST" "curl -sf -o /dev/null -w 'healthz → HTTP %{http_code}\n' http://127.0.0.1:3110/healthz"

echo "✅ Xong → https://$(ssh -G \"$HOST\" | awk '/^hostname /{print $2}'):8446"
