-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  002 — Nối Pancake POS để bắt đơn tự động                                ║
-- ║                                                                          ║
-- ║  Trước migration này, "khách đã chốt" chỉ nhận ra được qua 2 đường:      ║
-- ║  webhook /webhook/order (cần người nối hệ thống ngoài) và tag mua hàng   ║
-- ║  trên hội thoại (cần nhân viên gắn tay). Cả hai đều có thể không xảy ra  ║
-- ║  → khách đã mua vẫn nhận đủ 28 tin.                                      ║
-- ║                                                                          ║
-- ║  POS giữ số đơn TRỌN ĐỜI của khách. Nên không thể chỉ nhìn "có đơn hay  ║
-- ║  không" — người mua 6 tháng trước mà nay nhắn lại là khách ấm, đáng nuôi ║
-- ║  dưỡng tiếp. Vì vậy lưu một MỐC CHUẨN lúc khách vào chuỗi, rồi chỉ dừng  ║
-- ║  khi số đơn VƯỢT mốc đó (đổi được bằng POS_CONVERT_MODE=any).            ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

ALTER TABLE customers
    -- Số đơn POS tại thời điểm khách vào (hoặc quay lại) chuỗi.
    -- NULL = chưa từng đối chiếu với POS lần nào.
    ADD COLUMN order_count_baseline INTEGER,
    ADD COLUMN pos_checked_at       TIMESTAMPTZ;

-- Job POS quét khách active của một page, ưu tiên người lâu chưa đối chiếu
CREATE INDEX customers_pos_idx
    ON customers (page_id, pos_checked_at NULLS FIRST)
    WHERE status = 'active';

-- Page có gắn shop POS mới cần đối chiếu
CREATE INDEX pages_pos_shop_idx
    ON pages (pancake_shop_id)
    WHERE pancake_shop_id IS NOT NULL AND is_active;

-- Sự kiện 'ordered' đã có sẵn trong enum customer_event từ 001 — dùng lại.
