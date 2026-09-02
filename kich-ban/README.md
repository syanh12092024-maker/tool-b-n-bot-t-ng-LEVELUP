# Kịch bản nuôi dưỡng

Mỗi page một file. Đặt tên theo page cho dễ tìm: `saudi-talpha.json`, `japan-page2.txt`…

- **12 nội dung** (cấu hình `MESSAGE_COUNT`), xoay vòng trên hành trình 7 ngày × 4 khung giờ.
- Gợi ý chia 3 cụm 4 tin:
  - **A (tin 1–4)** giới thiệu & báo giá — khách nhận ngày 1, 4, 7
  - **B (tin 5–8)** bằng chứng: feedback, ảnh khách, cam kết — ngày 2, 5
  - **C (tin 9–12)** thúc chốt: ưu đãi có hạn, khan hàng, hỏi thẳng — ngày 3, 6
- `media` là **URL ảnh công khai** (Facebook/Pancake phải tải được). Không nhét base64.
- Nạp: `npm run script:seed -- --page <id> --file kich-ban/<file>.json`

`mau.json` là khung để chép ra, mọi dòng `[THAY NỘI DUNG]` phải được thay trước khi nạp.
