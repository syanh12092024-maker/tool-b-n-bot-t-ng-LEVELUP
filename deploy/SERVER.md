# Vận hành trên VPS

Máy chủ `talpha-server` (169.58.33.8), Ubuntu 24.04. Cài tại `/opt/banbot`.

| Thành phần | Giá trị |
|---|---|
| Dashboard | https://169.58.33.8:8446 (nginx → 127.0.0.1:3110) |
| Webhook | 127.0.0.1:3111 (chưa mở ra ngoài) |
| Database | PostgreSQL 16, database `banbot`, user `banbot` |
| Bí mật | `/opt/banbot/.env` (chmod 600) — KHÔNG có trong git |
| Log | `/root/.pm2/logs/banbot-*.log` |

## Tiến trình pm2

| Tên | Lịch | Việc |
|---|---|---|
| `banbot-web` | liên tục | dashboard |
| `banbot-webhook` | liên tục | nhận đơn / tin khách |
| `banbot-sync` | phút 5 mỗi giờ | đồng bộ page nào đang 3h sáng giờ địa phương |
| `banbot-send` | mỗi 5 phút | gửi lượt tới hạn |
| `banbot-pos` | 8,23,38,53 | đối chiếu đơn POS |
| `banbot-health` | 2,17,32,47 | giám sát sức khoẻ page |

Job theo lịch dùng `autorestart:false` + `cron_restart` → trạng thái `stopped`
giữa hai lượt là **bình thường**, không phải lỗi.

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
pm2 delete banbot-web banbot-webhook banbot-send banbot-sync banbot-pos banbot-health
pm2 save
rm /etc/nginx/sites-enabled/banbot && systemctl reload nginx
# dữ liệu vẫn còn trong database banbot — xoá riêng nếu muốn
```
