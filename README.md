# Bắn bot TALPHA v2

Hệ thống nuôi dưỡng khách qua Messenger. Mỗi đêm tự làm mới tệp khách từ Pancake;
mỗi khách đi một hành trình **7 ngày** của riêng mình, nhận **4 tin/ngày** (6h · 11h · 17h · 21h
giờ địa phương), xoay vòng trên **12 nội dung**; dừng khi khách **chốt đơn** hoặc **nhắn từ chối**.

Bản thiết kế đầy đủ: xem artifact *Bắn bot TALPHA v2* (8 quyết định đã chốt, sơ đồ 4 tiến trình, bảng xoay vòng).

---

## Kiến trúc trong một hình

```
                ┌──────────┐   ghi    ┌─────────────────┐
  Pancake ────▶ │ 1 · SYNC │ ───────▶ │   customers     │
                └──────────┘          │   (tệp khách)   │
                      │ gọi           └────────┬────────┘
                      ▼                        │ đọc
                ┌──────────┐   ghi    ┌────────▼────────┐
                │ 2 · PLAN │ ───────▶ │   send_queue    │
                └──────────┘          │ (hàng đợi hôm nay)
                                      └────────┬────────┘
                                               │ FOR UPDATE SKIP LOCKED
                ┌──────────┐   lấy lô ◀────────┘
  Pancake ◀──── │ 3 · SEND │ ───────▶ send_log (từng tin)
  Facebook ◀─── └──────────┘
                ┌───────────┐  đọc send_log → pause / degrade / recover
                │ 4 · HEALTH│
                └───────────┘
  khách nhắn ─▶ ┌───────────┐  opt-out · chốt đơn → dừng chuỗi, huỷ hàng đợi
  đơn hàng ───▶ │  WEBHOOK  │
                └───────────┘
```

Bốn tiến trình **không gọi nhau** — chỉ đọc/ghi PostgreSQL. Ràng buộc quan trọng nhất:
`UNIQUE (customer_id, journey_day, slot_index)` trên `send_queue` — chống gửi trùng ở tầng
database, không phụ thuộc có bao nhiêu tiến trình đang chạy.

---

## Yêu cầu

- Node.js ≥ 20
- PostgreSQL ≥ 14 (dev: `docker compose up -d`)
- Token Pancake CRM (bắt buộc) · token Facebook user (tuỳ chọn, cho đường dự phòng)

## Cài đặt

```bash
cp .env.example .env        # điền DATABASE_URL, PANCAKE_CRM_TOKEN, (FB_USER_ACCESS_TOKEN)
npm install
npm run migrate             # tạo schema
npm run check:db            # kết nối + bảng
npm run check:tokens        # token còn sống không
```

**Chưa có PostgreSQL trên máy?** `npm run db:dev` dựng một Postgres thật ngay trong
`tmp/pgdata` (không cần cài Postgres hay Docker), in ra `DATABASE_URL` để dán vào `.env`.
Dùng cho máy dev; trên VPS dùng Postgres cài đặt thật.

## Kiểm tra

```bash
npm run test:smoke          # 115 kiểm tra tích hợp trên Postgres nhúng tạm
```

Bộ kiểm tra dựng DB sạch, chạy migration, rồi đi qua đúng luồng SYNC → PLAN → SEND →
HEALTH → WEBHOOK bằng dữ liệu giả. Không cần token. Nó kiểm chứng những thứ khó nhìn bằng mắt:

- `UNIQUE (customer_id, journey_day, slot_index)` — chạy PLAN hai lần không xếp trùng
- `FOR UPDATE SKIP LOCKED` — ba worker song song không ai lấy trùng lượt của ai
- Công thức xoay vòng ánh xạ đúng vào `script_messages`
- Khách rơi khỏi cửa sổ 7 ngày rồi nhắn lại → vào chuỗi lại từ ngày 1
- Khách đã chặn không bị sync hồi sinh
- Page bị ngưng → `pickBatch` không lấy gì dù lượt đã tới hạn
- Quy đổi giờ địa phương → UTC cho cả Riyadh (+3) lẫn Tokyo (+9)

Phần **không** được phủ: gọi API Pancake/Facebook thật (cần token — dùng `npm run check:tokens`).

## Đưa một page vào chạy

```bash
# 1. Xem Pancake nhìn thấy page nào
npm run page:list

# 2. Thêm page (chưa bật)
npm run page:add -- --page 123456789 --market Saudi

# 3. Soạn 12 nội dung — chép kich-ban/mau.json ra file riêng, thay hết [THAY NỘI DUNG]
npm run script:seed -- --page 123456789 --file kich-ban/saudi.json

# 4. Đồng bộ tệp khách lần đầu (vài phút, quét lùi tới 3 năm)
npm run job:sync -- --page 123456789

# 5. Xem thử sẽ xếp bao nhiêu lượt hôm nay, chưa ghi gì
npm run job:plan -- --page 123456789 --force --dry-run

# 6. Bật. Page mới gửi 25% tệp trong 3 ngày đầu rồi tăng dần lên 100%
npm run page:add -- --page 123456789 --market Saudi --activate
```

Thị trường có sẵn: Saudi · UAE · Kuwait · Oman · Qatar · Bahrain · Japan · Taiwan
(thị trường khác: thêm `--offset <giờ UTC>`).

## Chạy trên VPS

```bash
npm run build                          # → dist/
pm2 start ecosystem.config.cjs         # 4 app: webhook (liên tục) + send/sync/health (theo lịch)
pm2 save && pm2 startup
pm2 logs banbot-send
```

Không dùng pm2? Xem `deploy/crontab.example` + `deploy/banbot-webhook.service`.

| Job     | Lịch          | Làm gì                                                        |
|---------|---------------|---------------------------------------------------------------|
| sync    | mỗi giờ       | tự chọn page đang ở `SYNC_HOUR_LOCAL` (3h) giờ địa phương → quét Pancake → gọi plan |
| send    | mỗi 5 phút    | lấy lượt tới hạn, gửi theo lô, ngân sách 4,5 phút/lượt        |
| health  | mỗi 15 phút   | đọc `send_log` 60 phút → pause / degrade / recover từng page   |
| webhook | liên tục      | `POST /webhook/message` · `POST /webhook/order` · `GET /health` |

## Lệnh hay dùng

```bash
npm run job:sync   -- --page <id>            # đồng bộ ngay một page (bỏ qua kiểm tra giờ)
npm run job:sync   -- --force                # đồng bộ mọi page đang bật
npm run job:plan   -- --page <id> --dry-run  # xem sẽ xếp gì
npm run job:send   -- --page <id>            # gửi ngay những lượt tới hạn của một page
npm run job:send   -- --loop                 # chạy liên tục, 60s một lượt (khi không có cron)
npm run job:health -- --page <id>
npm run test:smoke                           # bộ kiểm tra tích hợp
npm run db:dev                               # Postgres nhúng cho máy dev
```

## Webhook

```bash
# khách vừa nhắn
curl -X POST localhost:8080/webhook/message -H 'x-webhook-secret: …' \
  -d '{"page_id":"123456789","psid":"98765","text":"stop"}'
# khách vừa chốt đơn
curl -X POST localhost:8080/webhook/order -H 'x-webhook-secret: …' \
  -d '{"page_id":"123456789","psid":"98765","order_id":"DH001"}'
```

Từ khoá từ chối (Anh · Việt · Ả Rập · Nhật · Trung) nằm ở `src/domain/rules.ts`.
`STOP_ON_REPLY=false` (mặc định): khách trả lời bình thường **vẫn** nhận chuỗi tiếp;
đổi thành `true` để dừng ngay khi khách nhắn lại.

## Vận hành

```sql
-- Hàng đợi hôm nay của một page
SELECT state, COUNT(*) FROM send_queue q JOIN pages p ON p.id = q.page_id
 WHERE p.page_id = '123456789' AND scheduled_at::date = current_date GROUP BY state;

-- Một khách đã nhận gì
SELECT l.sent_at, l.journey_day, l.slot_index, l.channel, l.success, l.error_kind, left(m.body, 60)
  FROM send_log l LEFT JOIN script_messages m ON m.id = l.script_message_id
 WHERE l.customer_id = 42 ORDER BY l.sent_at DESC;

-- Tin số mấy ra đơn nhiều nhất (khách chốt ở ngày thứ mấy)
SELECT journey_day, COUNT(*) FROM customer_events WHERE type = 'ordered' GROUP BY 1 ORDER BY 1;

-- Tạm dừng khẩn cấp một page
UPDATE pages SET is_active = FALSE WHERE page_id = '123456789';
```

## Cấu trúc

```
migrations/001_init.sql      schema — mọi ràng buộc quan trọng nằm ở đây
src/config/                  env (zod) · bảng múi giờ thị trường
src/domain/                  journey.ts (công thức xoay vòng) · rules.ts (tag mua hàng, từ khoá từ chối) · types.ts
src/clients/                 pancake.ts (quét + gửi chính) · facebook.ts (dự phòng, thang 4 tag)
src/db/                      pool · migrate · repositories/ (pages, customers, scripts, queue, health)
src/jobs/                    sync · plan · send · health · webhook
src/scripts/                 check-db · check-tokens · page:add · page:list · script:seed
                             smoke-test.ts (115 kiểm tra) · dev-db.ts (Postgres nhúng)
kich-ban/                    nội dung kịch bản (mau.json là khung)
deploy/                      crontab + systemd mẫu
ecosystem.config.cjs         pm2
```

## Khác bản v1 ở đâu

| | v1 | v2 |
|---|---|---|
| Tệp khách | quét lại mỗi lần bắn, cache 10 phút | bảng `customers`, đồng bộ hằng đêm, nhớ lịch sử |
| Nội dung | cả tệp nhận cùng một tin | mỗi khách theo ngày thứ N của riêng mình |
| Chống trùng | RAM — 2 tiến trình là hỏng | `UNIQUE` ở database |
| Nhật ký | tổng số/đoạn | `send_log` từng tin |
| Biết ai đã chốt | không | webhook + tag → dừng chuỗi |
| Sức khoẻ page | cầu dao 30' | đo mỗi 15', hãm tốc trước khi bị chặn, leo thang |
| Nơi chạy | Mac cá nhân | VPS 24/7 |
