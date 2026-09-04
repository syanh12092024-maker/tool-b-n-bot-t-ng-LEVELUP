-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  003 — Lưu kết quả phân tích hội thoại để hiện trên dashboard            ║
-- ║                                                                          ║
-- ║  Phân tích 100 hội thoại mất vài phút và gọi API Pancake ~100 lần, nên   ║
-- ║  không thể chạy lại mỗi lần mở trang. Chạy một lần, lưu lại, dashboard   ║
-- ║  đọc ra. Người soạn nội dung nhìn số liệu ngay cạnh ô nhập.              ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

CREATE TABLE page_analysis (
    page_id       BIGINT      PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
    -- Toàn bộ báo cáo dạng JSON: câu hỏi hay gặp, giá, vấn đề, câu chốt được khách…
    report        JSONB       NOT NULL,
    conversations INTEGER     NOT NULL DEFAULT 0,
    analyzed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Nhắc chạy lại khi số liệu đã cũ (quyết định 11: hệ thống nhắc, người bấm)
CREATE INDEX page_analysis_stale_idx ON page_analysis (analyzed_at);
