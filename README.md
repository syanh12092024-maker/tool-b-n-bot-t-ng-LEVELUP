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
  Pancake POS ▶ ┌───────────┐  số đơn tăng → converted, huỷ lượt còn chờ
                │  5 · POS  │  (không cần ai gắn tag hay nối hệ thống ngoài)
                └───────────┘
                ┌───────────┐  đọc mọi bảng trên, KHÔNG ghi gì
   người xem ◀─ │ DASHBOARD │  tổng quan · hiệu quả tin · tra cứu khách
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
npm run test:smoke          # 195 kiểm tra tích hợp trên Postgres nhúng tạm
```

Bộ kiểm tra dựng DB sạch, chạy migration, rồi đi qua đúng luồng SYNC → PLAN → SEND →
POS → HEALTH → WEBHOOK → DASHBOARD bằng dữ liệu giả. Không cần token. Nó kiểm chứng những thứ khó nhìn bằng mắt:

- `UNIQUE (customer_id, journey_day, slot_index)` — chạy PLAN hai lần không xếp trùng
- `FOR UPDATE SKIP LOCKED` — ba worker song song không ai lấy trùng lượt của ai
- Công thức xoay vòng ánh xạ đúng vào `script_messages`
- Khách rơi khỏi cửa sổ 7 ngày rồi nhắn lại → vào chuỗi lại từ ngày 1
- Khách đã chặn không bị sync hồi sinh
- Page bị ngưng → `pickBatch` không lấy gì dù lượt đã tới hạn
- Quy đổi giờ địa phương → UTC cho cả Riyadh (+3) lẫn Tokyo (+9)
- Mốc chuẩn POS: khách mua từ trước vẫn được nuôi dưỡng, mua thêm thì mới dừng
- Dashboard escape tên khách lấy từ Facebook (không chèn được thẻ script)
- Báo cáo quy công đúng vào tin cuối khách nhận trước lúc chốt
- Sửa kịch bản trên web: giữ nguyên id tin, chặn POST từ trang lạ (CSRF)

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
| pos     | mỗi 15 phút   | đối chiếu đơn từ Pancake POS → dừng chuỗi cho khách vừa chốt   |
| health  | mỗi 15 phút   | đọc `send_log` 60 phút → pause / degrade / recover từng page   |
| webhook | liên tục      | `POST /webhook/message` · `POST /webhook/order` · `GET /health` |
| web     | liên tục      | dashboard chỉ đọc ở cổng 8090                                  |

## Lệnh hay dùng

```bash
npm run job:sync   -- --page <id>            # đồng bộ ngay một page (bỏ qua kiểm tra giờ)
npm run job:sync   -- --force                # đồng bộ mọi page đang bật
npm run job:plan   -- --page <id> --dry-run  # xem sẽ xếp gì
npm run job:send   -- --page <id>            # gửi ngay những lượt tới hạn của một page
npm run job:send   -- --loop                 # chạy liên tục, 60s một lượt (khi không có cron)
npm run job:pos    -- --page <id> --dry-run  # xem POS có bao nhiêu khách của page
npm run job:health -- --page <id>
npm run test:smoke                           # bộ kiểm tra tích hợp
npm run db:dev                               # Postgres nhúng cho máy dev
npm run web                                  # dashboard
npm run seed:demo                            # dữ liệu mẫu để xem dashboard
```

## Dashboard

```bash
npm run web        # → http://localhost:8090
```

Sửa được **nội dung kịch bản** ngay trên web (`/page/:id/script/edit`) — việc này làm hằng tuần,
bắt SSH vào server sửa file JSON là không dùng được. Mọi thứ còn lại (thêm page, **bật/tắt page**,
hàng đợi gửi) vẫn chỉ qua CLI, nên dashboard không thể tự ý bật một chiến dịch.

Form lưu có chặn CSRF bằng `Origin`/`Referer`. Khi sửa, **id của từng tin được giữ nguyên** — nếu
tạo bản ghi mới thì báo cáo "tin nào ra đơn" sẽ mất sạch lịch sử của tin cũ.

| Trang | Trả lời câu hỏi |
|---|---|
| `/` Tổng quan | Page nào đang chạy, bao nhiêu khách đang nuôi, hôm nay gửi được bao nhiêu, page nào đang bị ngưng |
| `/page/:id` | Khách phân bố ở ngày nào, hàng đợi ra sao, lỗi gì trong 24h, sức khoẻ page theo từng 15 phút |
| `/page/:id/script` | 12 nội dung + bảng lịch: khách nhận tin số mấy vào ngày nào |
| `/page/:id/script/edit` | **sửa nội dung ngay trên web** — ô nào chưa điền xong có cảnh báo |
| `/report` | **Tin nào ra đơn nhiều nhất** · khách thường chốt ở ngày thứ mấy |
| `/customer/:id` | Một khách đã nhận gì, lúc nào, qua kênh nào, sắp nhận gì |
| `/search?q=` | Tra theo tên · số điện thoại · PSID |

Bảo vệ bằng HTTP Basic: đặt `DASHBOARD_PASSWORD` trong `.env` (bỏ trống = mở, chỉ nên dùng khi
chạy local). Trang tự đổi sáng/tối theo hệ điều hành, không gọi CDN nào — chạy được cả khi VPS
bị chặn ra ngoài.

### Cách tính "tin nào ra đơn nhiều nhất"

Quy công theo **chạm cuối**: mỗi khách đã chốt được tính cho tin **cuối cùng** họ nhận thành công
trước thời điểm chốt. Không hoàn hảo — khách có thể đã quyết định từ tin trước đó — nhưng nhất
quán và đủ để so sánh các tin với nhau. Nếu tin #9 (ưu đãi có hạn) ra đơn gấp ba tin #3, đó là
tín hiệu thật để anh/chị viết lại tin #3.

### Xem thử trước khi có dữ liệu thật

```bash
npm run db:dev      # cửa sổ 1: Postgres nhúng
npm run seed:demo   # cửa sổ 2: dựng 4 page mẫu ~900 khách, nhật ký gửi, đơn hàng
npm run web         # → http://localhost:8090
```

`seed:demo` **xoá sạch** mọi page có tiền tố `DEMO_` rồi tạo lại; không đụng page thật. Chỉ chạy
trên database dev.

## Bắt đơn tự động (POS)

Hệ thống nhận biết khách đã chốt qua **ba** đường, đường nào tới trước thì dừng chuỗi:

| Đường | Cần gì | Ghi chú |
|---|---|---|
| Tag mua hàng | nhân viên gắn tag lên hội thoại | chạy trong job `sync`, danh sách tag ở `src/domain/rules.ts` |
| Webhook đơn | ai đó nối hệ thống ngoài gọi `/webhook/order` | tức thì |
| **POS** | `config/pos-shops.json` | tự động, không cần ai đổi thói quen |

```bash
cp config/pos-shops.example.json config/pos-shops.json   # điền shop_id + api_key thật
npm run check:tokens                                     # kiểm khoá từng shop
npm run job:pos -- --dry-run                             # xem POS có bao nhiêu khách
```

Rồi gắn shop vào page: `npm run page:add -- --page <id> --market Saudi --shop <shop_id>`.
Page không gắn shop thì job POS bỏ qua. Nhiều page dùng chung một shop chỉ gọi POS **một lần** mỗi lượt.

### Vì sao có "mốc chuẩn"

POS đếm đơn **trọn đời**, nên "có đơn" không đồng nghĩa "vừa chốt trong chuỗi này". Người mua
6 tháng trước mà nay nhắn lại là khách ấm, đáng nuôi dưỡng tiếp. Vì vậy lần đối chiếu đầu tiên
chỉ **ghi mốc** bằng đúng số đơn hiện có, và chỉ dừng chuỗi khi số đơn **vượt** mốc đó.

```
P2 vào chuỗi, POS báo 3 đơn  →  ghi mốc = 3, vẫn nuôi dưỡng
POS báo 3 đơn (lượt sau)     →  không đổi
POS báo 4 đơn                →  vượt mốc → converted, huỷ lượt còn chờ
P2 rơi khỏi cửa sổ rồi quay lại → xoá mốc, lần đối chiếu sau ghi mốc mới = 4
```

Muốn dừng **mọi** người từng có đơn thì đặt `POS_CONVERT_MODE=any` trong `.env`.

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
migrations/                  001_init.sql (schema gốc) · 002_pos.sql (mốc chuẩn POS)
src/config/                  env (zod) · bảng múi giờ thị trường
src/domain/                  journey.ts (công thức xoay vòng) · rules.ts (tag mua hàng, từ khoá từ chối) · types.ts
src/clients/                 pancake.ts (quét + gửi chính) · facebook.ts (dự phòng, thang 4 tag) · pos.ts (đơn hàng)
src/db/                      pool · migrate · repositories/ (pages, customers, scripts, queue, health, report)
src/jobs/                    sync · plan · send · pos · health · webhook
src/web/                     server.ts (định tuyến) · views.ts (các trang) · html.ts (CSS + escape)
src/scripts/                 check-db · check-tokens · page:add · page:list · script:seed
                             smoke-test.ts (195 kiểm tra) · dev-db.ts · seed-demo.ts
config/                      pos-shops.json (gitignore, chép từ .example) — khoá POS từng shop
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
| Biết ai đã chốt | không | POS + webhook + tag → dừng chuỗi |
| Sức khoẻ page | cầu dao 30' | đo mỗi 15', hãm tốc trước khi bị chặn, leo thang |
| Nơi chạy | Mac cá nhân | VPS 24/7 |
| Đo hiệu quả | không có | dashboard: tin nào ra đơn, chốt ở ngày mấy |
