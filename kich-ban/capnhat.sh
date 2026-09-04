#!/usr/bin/env bash
# Cập nhật kịch bản lên server sau khi sửa file JSON.
#
#   bash kich-ban/capnhat.sh <page-id> <tên-file.json>
#
# Ví dụ:
#   bash kich-ban/capnhat.sh 1163618183501879 al-shifa-saudi-NHAP.json
set -euo pipefail
cd "$(dirname "$0")/.."

PAGE=${1:?"Thiếu page id. Ví dụ: bash kich-ban/capnhat.sh 1163618183501879 al-shifa-saudi-NHAP.json"}
FILE=${2:?"Thiếu tên file. Ví dụ: bash kich-ban/capnhat.sh 1163618183501879 al-shifa-saudi-NHAP.json"}
HOST=${BANBOT_HOST:-talpha-server}

[ -f "kich-ban/$FILE" ] || { echo "❌ Không thấy file kich-ban/$FILE"; exit 1; }

echo "▶ Kiểm tra file có đúng định dạng không…"
node -e "
const m=JSON.parse(require('fs').readFileSync('kich-ban/$FILE','utf8'));
if(!Array.isArray(m)) throw new Error('File phải là một danh sách');
const trong=m.filter(x=>!(x.body||'').trim() && !(x.media||[]).length);
if(trong.length) throw new Error(trong.length+' tin bị bỏ trống');
const chua=m.filter(x=>/\[ĐIỀN|\[THAY/.test(x.body||''));
console.log('  ✅ '+m.length+' nội dung, định dạng đúng');
if(chua.length){ console.log('  ⚠️  '+chua.length+' tin còn chỗ chưa điền:'); chua.forEach(x=>console.log('     • '+x.label)); }
"

echo "▶ Đưa lên server…"
scp -q "kich-ban/$FILE" "$HOST:/opt/banbot/kich-ban/"

echo "▶ Áp dụng…"
ssh "$HOST" "cd /opt/banbot && node dist/scripts/seed-script.js --page $PAGE --file kich-ban/$FILE" 2>&1 | grep -vE '^\s+.35m' | tail -16

echo
echo "✅ Xong. Xem lại trên web ở mục Kịch bản của page."
echo "   Bản cũ vẫn được giữ, không bị xoá."
