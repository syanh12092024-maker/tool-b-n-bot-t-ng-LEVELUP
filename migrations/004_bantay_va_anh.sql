-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  004 — Bắn tay từ giao diện + chỗ lưu ảnh                                ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- ─── Ảnh ───────────────────────────────────────────────────────────────────
-- Lưu trong database chứ KHÔNG để trên đĩa: bản v1 từng hỏng đúng chỗ này —
-- Next.js không phục vụ file ghi thêm sau khi build, nên ảnh gửi đi thành link
-- chết. Để trong DB thì không phụ thuộc quyền ghi, sống qua mọi lần deploy lại,
-- và được sao lưu cùng dữ liệu. Ảnh đã nén nên mỗi tấm chỉ khoảng 100–200KB.
CREATE TABLE media (
    id         TEXT        PRIMARY KEY,          -- chuỗi ngẫu nhiên, dùng làm URL
    mime       TEXT        NOT NULL,
    bytes      BYTEA       NOT NULL,
    size       INTEGER     NOT NULL,
    page_id    BIGINT      REFERENCES pages(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX media_page_idx ON media (page_id, created_at DESC);


-- ─── Bắn tay ───────────────────────────────────────────────────────────────
-- Giao diện cho chọn khách rồi gửi ngay một nội dung tuỳ ý. Nội dung đó không
-- thuộc kịch bản nào, nên script_message_id phải cho phép rỗng và nội dung đi
-- kèm ngay trong hàng đợi.
--
-- Vẫn đi qua ĐÚNG đường gửi của engine: chống trùng, cầu dao page, hãm tốc,
-- nhật ký từng tin — tất cả đều áp dụng. Bản v1 có đường gửi riêng cho nút này
-- nên mọi lớp bảo vệ đều bị bỏ qua.
ALTER TABLE send_queue
    ALTER COLUMN script_message_id DROP NOT NULL,
    ADD COLUMN manual         BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN override_body  TEXT,
    ADD COLUMN override_media TEXT[] NOT NULL DEFAULT '{}';

-- Ràng buộc chống trùng của chuỗi nuôi dưỡng chỉ áp cho lượt THEO LỊCH.
-- Bắn tay được phép gửi lại cùng một khách (người dùng chủ động bấm).
ALTER TABLE send_queue DROP CONSTRAINT send_queue_customer_id_journey_day_slot_index_key;
CREATE UNIQUE INDEX send_queue_journey_unique
    ON send_queue (customer_id, journey_day, slot_index) WHERE NOT manual;

-- Mỗi lượt phải có nội dung: hoặc trỏ vào kịch bản, hoặc mang chữ/ảnh riêng
ALTER TABLE send_queue ADD CONSTRAINT send_queue_has_content CHECK (
    script_message_id IS NOT NULL
    OR btrim(COALESCE(override_body, '')) <> ''
    OR COALESCE(array_length(override_media, 1), 0) > 0
);

CREATE INDEX send_queue_manual_idx ON send_queue (page_id, created_at DESC) WHERE manual;
