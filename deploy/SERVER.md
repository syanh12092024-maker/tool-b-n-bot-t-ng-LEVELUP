# Vận hành trên VPS

Máy chủ: host `talpha-server` trong `~/.ssh/config` (repo này công khai nên không
ghi địa chỉ thật ở đây). Ubuntu 24.04, cài tại `/opt/banbot`.

| Thành phần | Giá trị |
|---|---|
| Giao diện chính | `https://<IP máy chủ>:8447` (nginx → 127.0.0.1:3112) — chọn page, bảng khách, soạn tin, bắn ngay |
| Dashboard chỉ đọc | `https://<IP máy chủ>:8446` (nginx → 127.0.0.1:3110) — báo cáo, truy vết khách |
| Webhook | 127.0.0.1:3111 (chưa mở ra ngoài) |
| Database | PostgreSQL 16, database `banbot`, user `banbot` |
| Bí mật | `/opt/banbot/.env` (chmod 600) — KHÔNG có trong git |
| Log | `/root/.pm2/logs/banbot-*.log` |

## Tiến trình pm2

| Tên | Lịch | Việc |
|---|---|---|
| `banbot-ui` | liên tục | giao diện chính (Next.js) |
| `banbot-web` | liên tục | dashboard chỉ đọc |
| `banbot-webhook` | liên tục | nhận đơn / tin khách |
| `banbot-sync` | phút 5 mỗi giờ | đồng bộ page nào đang 3h sáng giờ địa phương |
| `banbot-send` | mỗi phút | gửi lượt tới hạn (cả theo lịch lẫn bắn tay) |
| `banbot-pos` | 8,23,38,53 | đối chiếu đơn POS |
| `banbot-health` | 2,17,32,47 | giám sát sức khoẻ page |

Job theo lịch dùng `autorestart:false` + `cron_restart` → trạng thái `stopped`
giữa hai lượt là **bình thường**, không phải lỗi.

### ⚠️ Đổi lịch chạy thì phải TẠO LẠI tiến trình

`pm2 restart` **không** nạp lại `cron_restart` — pm2 vẫn chạy lịch cũ và không
báo gì. Kiểm tra lịch thật bằng `pm2 describe banbot-send | grep cron`.

```bash
pm2 delete banbot-send && pm2 start ecosystem.config.cjs --only banbot-send && pm2 save
```

Hoặc chạy `RELOAD_CRON=1 bash deploy/deploy.sh` để nạp lại lịch cho cả 4 job.

## Lệnh hay dùng

```bash
ssh talpha-server
cd /opt/banbot

node dist/scripts/list-pages.js                      # 347 page từ Pancake
node dist/scripts/add-page.js --page <id> --market Saudi
node dist/scripts/seed-script.js --page <id> --file kich-ban/<file>.json
node dist/jobs/sync.js --page <id> --dry-run         # thử, không ghi
node dist/scripts/add-page.js --page <id> --market Saudi --activate   # BẮT ĐẦU GỬI

pm2 logs banbot-send --lines 50
sudo -u postgres psql -d banbot
```

## Bật một page — thứ tự bắt buộc

1. `add-page` (chưa bật)
2. `seed-script` — **không có kịch bản thì page không gửi được gì**
3. `sync --dry-run` xem quét được bao nhiêu khách
4. `sync` thật
5. `add-page --activate` ← **từ đây mới thật sự gửi tin cho khách**

Page mới bật chạy ở chế độ khởi động dần: 25% tệp trong 3 ngày đầu.

## Gỡ cài đặt

```bash
pm2 delete banbot-ui banbot-web banbot-webhook banbot-send banbot-sync banbot-pos banbot-health
pm2 save
rm /etc/nginx/sites-enabled/banbot /etc/nginx/sites-enabled/banbot-ui && systemctl reload nginx
# dữ liệu vẫn còn trong database banbot — xoá riêng nếu muốn
```

## Ảnh

Ảnh dán vào ô soạn được lưu **trong database** (bảng `media`), không để trên đĩa.
Bản v1 ghi vào `public/uploads` rồi gửi link đi, nhưng Next.js không phục vụ file
ghi thêm sau khi build nên khách nhận link chết.

`PUBLIC_URL` trong `web/.env.local` đặt là `http://127.0.0.1:3112` — **cố ý dùng
địa chỉ nội bộ**. Engine tự tải ảnh về rồi upload nhị phân lên Pancake, nên link
chỉ cần server tự truy cập được; Facebook không bao giờ phải tải từ link này.
Nhờ vậy chứng chỉ tự ký không gây trở ngại.

## Xây lại giao diện sau khi sửa code

```bash
cd /opt/banbot/web
nohup npm run build > ../logs/ui-build.log 2>&1 &   # nohup: build sống khi ngắt SSH
# chờ .next/BUILD_ID xuất hiện rồi:
pm2 restart banbot-ui
```

Build mất vài phút. **Phải có `nohup`** — không thì build chết theo phiên SSH.

## Cổng và bảo mật

Cả ba tiến trình web chỉ nghe trên **127.0.0.1**, nginx là cửa duy nhất vào từ ngoài.

| Cổng | Nghe ở | Vào từ ngoài qua |
|---|---|---|
| 3112 | 127.0.0.1 | nginx `:8447` (basic-auth) — giao diện chính, **có nút gửi tin** |
| 3110 | 127.0.0.1 | nginx `:8446` (mật khẩu ở app) — dashboard chỉ đọc |
| 3111 | 127.0.0.1 | **chưa mở** — webhook, xem cảnh báo dưới |

Kiểm chứng lại bất cứ lúc nào — cả ba phải **không kết nối được**:

```bash
for p in 3110 3111 3112; do curl -m 5 -o /dev/null -w "$p: %{http_code}\n" http://<IP>:$p/; done
```

### Vì sao webhook chưa mở

`WEBHOOK_SECRET` còn trống. Mở cổng 3111 ra Internet khi chưa có secret nghĩa là
**ai cũng gửi đơn giả vào được**, khiến khách thật bị đánh dấu "đã mua" và ngừng
nhận tin. Muốn mở: đặt `WEBHOOK_SECRET` trong `.env`, đổi `WEBHOOK_HOST=0.0.0.0`,
rồi thêm site nginx trỏ vào.

### Một mật khẩu, không phải hai

Giao diện chính chặn ở **tầng nginx**, nên app không đòi `APP_ACCESS_KEY` nữa —
bắt người dùng nhập mật khẩu hai lần là dở mà không an toàn hơn. An toàn đến từ
việc cổng app không mở ra ngoài, chứ không phải từ số lần hỏi mật khẩu.
