-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  Bắn bot TALPHA v2 — schema gốc                                          ║
-- ║                                                                          ║
-- ║  Nguyên tắc: mọi ràng buộc quan trọng nằm ở TẦNG DATABASE, không nằm     ║
-- ║  trong bộ nhớ tiến trình. Bản v1 giữ khoá chống trùng trong RAM nên      ║
-- ║  chạy 2 tiến trình là khách nhận tin đôi — ở đây database từ chối thẳng. ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- ─── Kiểu liệt kê ──────────────────────────────────────────────────────────
CREATE TYPE page_health_state  AS ENUM ('ok', 'degraded', 'paused');
CREATE TYPE customer_status    AS ENUM ('active', 'converted', 'opted_out', 'expired');
CREATE TYPE queue_state        AS ENUM ('queued', 'sending', 'sent', 'failed', 'skipped');
CREATE TYPE send_channel       AS ENUM ('pancake', 'facebook');
CREATE TYPE customer_event     AS ENUM ('entered', 'replied', 'ordered', 'opted_out', 'expired', 'restarted');


-- ═══════════════════════════════════════════════════════════════════════════
-- PAGES — mỗi Fanpage đang chạy chiến dịch
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE pages (
    id                BIGSERIAL   PRIMARY KEY,
    page_id           TEXT        NOT NULL UNIQUE,   -- id Fanpage bên Facebook/Pancake
    page_name         TEXT        NOT NULL,
    market            TEXT        NOT NULL,          -- Saudi, UAE, Kuwait, Oman, Qatar, Bahrain, Japan, Taiwan
    utc_offset        SMALLINT    NOT NULL,          -- +3, +4, +9, +8 — quyết định giờ bắn
    pancake_shop_id   TEXT,

    is_active         BOOLEAN     NOT NULL DEFAULT FALSE,

    -- Sức khoẻ page (tầng bảo vệ cho mức 4 tin/ngày)
    health_state      page_health_state NOT NULL DEFAULT 'ok',
    paused_until      TIMESTAMPTZ,
    pause_reason      TEXT,
    pause_count_24h   SMALLINT    NOT NULL DEFAULT 0,

    -- Khởi động dần: page mới bật chỉ gửi một phần tệp
    activated_at      TIMESTAMPTZ,
    ramp_percent      SMALLINT    NOT NULL DEFAULT 100 CHECK (ramp_percent BETWEEN 0 AND 100),

    last_synced_at    TIMESTAMPTZ,
    last_planned_at   TIMESTAMPTZ,

    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT pages_utc_offset_sane CHECK (utc_offset BETWEEN -12 AND 14)
);

CREATE INDEX pages_active_idx ON pages (is_active) WHERE is_active;


-- ═══════════════════════════════════════════════════════════════════════════
-- SCRIPTS — kịch bản nuôi dưỡng. Mỗi page một kịch bản riêng.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE scripts (
    id             BIGSERIAL   PRIMARY KEY,
    page_id        BIGINT      NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    name           TEXT        NOT NULL,

    journey_days   SMALLINT    NOT NULL DEFAULT 7  CHECK (journey_days  BETWEEN 1 AND 7),
    slots_per_day  SMALLINT    NOT NULL DEFAULT 4  CHECK (slots_per_day BETWEEN 1 AND 4),
    message_count  SMALLINT    NOT NULL DEFAULT 12 CHECK (message_count BETWEEN 1 AND 28),

    is_active      BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Mỗi page chỉ được có ĐÚNG MỘT kịch bản đang bật
CREATE UNIQUE INDEX scripts_one_active_per_page ON scripts (page_id) WHERE is_active;


-- ═══════════════════════════════════════════════════════════════════════════
-- SCRIPT_MESSAGES — 12 nội dung của một kịch bản (order_index 0..11)
-- Công thức xoay vòng: msg_index = ((journey_day - 1) * slots_per_day + slot_index) % message_count
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE script_messages (
    id           BIGSERIAL   PRIMARY KEY,
    script_id    BIGINT      NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
    order_index  SMALLINT    NOT NULL CHECK (order_index >= 0),
    label        TEXT,                                   -- ghi chú vai trò: "báo giá", "feedback", "thúc chốt"
    body         TEXT        NOT NULL DEFAULT '',
    media        TEXT[]      NOT NULL DEFAULT '{}',      -- URL ảnh, không nhét base64 vào DB
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (script_id, order_index),
    -- Tin rỗng hoàn toàn là lỗi cấu hình, chặn ngay ở DB
    CONSTRAINT script_messages_not_empty
        CHECK (btrim(body) <> '' OR COALESCE(array_length(media, 1), 0) > 0)
);


-- ═══════════════════════════════════════════════════════════════════════════
-- CUSTOMERS — tệp khách. Đồng bộ lại mỗi đêm, KHÔNG xoá đi làm lại.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE customers (
    id                   BIGSERIAL   PRIMARY KEY,
    page_id              BIGINT      NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    psid                 TEXT        NOT NULL,           -- Facebook PSID
    conversation_id      TEXT,                           -- id hội thoại bên Pancake

    name                 TEXT,
    phone                TEXT,
    order_count          INTEGER     NOT NULL DEFAULT 0,
    tags                 TEXT[]      NOT NULL DEFAULT '{}',

    -- Mốc tính hành trình. Khách rơi ra rồi quay lại sẽ được reset về hôm nay.
    first_seen_at        TIMESTAMPTZ NOT NULL,
    last_interaction_at  TIMESTAMPTZ NOT NULL,
    journey_day          SMALLINT    NOT NULL DEFAULT 1 CHECK (journey_day >= 1),
    journey_count        SMALLINT    NOT NULL DEFAULT 1,  -- đã vào chuỗi bao nhiêu lần

    status               customer_status NOT NULL DEFAULT 'active',
    stop_reason          TEXT,
    stopped_at           TIMESTAMPTZ,

    synced_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (page_id, psid)
);

-- Index cho job PLAN: lấy khách đang active của một page
CREATE INDEX customers_plan_idx
    ON customers (page_id, journey_day)
    WHERE status = 'active';

-- Index cho job SYNC: tìm khách rơi khỏi cửa sổ 7 ngày
CREATE INDEX customers_window_idx ON customers (page_id, last_interaction_at);
CREATE INDEX customers_status_idx ON customers (page_id, status);


-- ═══════════════════════════════════════════════════════════════════════════
-- OPT_OUTS — danh sách chặn vĩnh viễn.
-- Tách riêng khỏi customers để KHÔNG mất khi tệp khách được đồng bộ lại.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE opt_outs (
    id              BIGSERIAL   PRIMARY KEY,
    page_id         BIGINT      NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    psid            TEXT        NOT NULL,
    matched_keyword TEXT,
    raw_message     TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (page_id, psid)
);


-- ═══════════════════════════════════════════════════════════════════════════
-- SEND_QUEUE — hàng đợi gửi.
--
-- ⭐ UNIQUE (customer_id, journey_day, slot_index) là ràng buộc quan trọng
--    nhất của cả hệ thống: một khách không thể nhận hai lần cùng một lượt,
--    bất kể bao nhiêu tiến trình đang chạy song song.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE send_queue (
    id                 BIGSERIAL   PRIMARY KEY,
    customer_id        BIGINT      NOT NULL REFERENCES customers(id)        ON DELETE CASCADE,
    page_id            BIGINT      NOT NULL REFERENCES pages(id)            ON DELETE CASCADE,
    script_message_id  BIGINT      NOT NULL REFERENCES script_messages(id)  ON DELETE CASCADE,

    journey_day        SMALLINT    NOT NULL,
    slot_index         SMALLINT    NOT NULL CHECK (slot_index >= 0),
    scheduled_at       TIMESTAMPTZ NOT NULL,             -- đã quy đổi sang UTC

    state              queue_state NOT NULL DEFAULT 'queued',
    attempt_count      SMALLINT    NOT NULL DEFAULT 0,
    locked_at          TIMESTAMPTZ,
    locked_by          TEXT,
    last_error         TEXT,

    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (customer_id, journey_day, slot_index)
);

-- Index cho job SEND: lấy job tới hạn, cũ nhất trước
CREATE INDEX send_queue_pick_idx
    ON send_queue (scheduled_at)
    WHERE state = 'queued';

-- Gỡ job kẹt ở trạng thái 'sending'
CREATE INDEX send_queue_stuck_idx
    ON send_queue (locked_at)
    WHERE state = 'sending';

CREATE INDEX send_queue_page_idx     ON send_queue (page_id, state);
CREATE INDEX send_queue_customer_idx ON send_queue (customer_id);


-- ═══════════════════════════════════════════════════════════════════════════
-- SEND_LOG — nhật ký TỪNG TIN, cả thành công lẫn thất bại.
-- Đây là nguồn dữ liệu duy nhất cho báo cáo và cho tầng giám sát sức khoẻ.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE send_log (
    id                 BIGSERIAL   PRIMARY KEY,
    queue_id           BIGINT      REFERENCES send_queue(id) ON DELETE SET NULL,
    customer_id        BIGINT      NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    page_id            BIGINT      NOT NULL REFERENCES pages(id)     ON DELETE CASCADE,
    script_message_id  BIGINT,

    journey_day        SMALLINT,
    slot_index         SMALLINT,

    channel            send_channel NOT NULL,
    fb_tag             TEXT,                    -- HUMAN_AGENT / POST_PURCHASE_UPDATE / ...
    success            BOOLEAN     NOT NULL,
    error_kind         TEXT,                    -- PAGE_QUOTA / PAGE_BLOCKED / OUT_OF_WINDOW / ...
    error_code         TEXT,
    error_message      TEXT,
    duration_ms        INTEGER,

    sent_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index cho tầng giám sát: đếm lỗi 1 giờ gần nhất của một page
CREATE INDEX send_log_health_idx   ON send_log (page_id, sent_at DESC);
-- Index để truy vết một khách cụ thể đã nhận gì
CREATE INDEX send_log_customer_idx ON send_log (customer_id, sent_at DESC);
-- Index cho báo cáo: tin số mấy ra đơn nhiều nhất
CREATE INDEX send_log_message_idx  ON send_log (script_message_id, success);


-- ═══════════════════════════════════════════════════════════════════════════
-- CUSTOMER_EVENTS — mọi thứ xảy ra với một khách, dùng cho báo cáo tỉ lệ chốt
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE customer_events (
    id           BIGSERIAL   PRIMARY KEY,
    customer_id  BIGINT         NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    page_id      BIGINT         NOT NULL REFERENCES pages(id)     ON DELETE CASCADE,
    type         customer_event NOT NULL,
    journey_day  SMALLINT,                 -- xảy ra ở ngày thứ mấy của hành trình
    payload      JSONB          NOT NULL DEFAULT '{}',
    occurred_at  TIMESTAMPTZ    NOT NULL DEFAULT now()
);

CREATE INDEX customer_events_customer_idx ON customer_events (customer_id, occurred_at DESC);
CREATE INDEX customer_events_report_idx   ON customer_events (page_id, type, occurred_at DESC);


-- ═══════════════════════════════════════════════════════════════════════════
-- PAGE_HEALTH — ảnh chụp sức khoẻ page mỗi 15 phút
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE page_health (
    id            BIGSERIAL   PRIMARY KEY,
    page_id       BIGINT      NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    window_start  TIMESTAMPTZ NOT NULL,
    sent          INTEGER     NOT NULL DEFAULT 0,
    failed        INTEGER     NOT NULL DEFAULT 0,
    error_2022    INTEGER     NOT NULL DEFAULT 0,   -- Facebook chặn page
    error_121     INTEGER     NOT NULL DEFAULT 0,   -- Pancake hết gói cước
    error_rate    NUMERIC(5,4) NOT NULL DEFAULT 0,
    action_taken  TEXT,                             -- degrade / pause / escalate / recover
    computed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (page_id, window_start)
);

CREATE INDEX page_health_recent_idx ON page_health (page_id, window_start DESC);


-- ═══════════════════════════════════════════════════════════════════════════
-- JOB_RUNS — mỗi lượt chạy của SYNC / PLAN / SEND / HEALTH
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE job_runs (
    id           BIGSERIAL   PRIMARY KEY,
    job          TEXT        NOT NULL,      -- sync | plan | send | health | webhook
    page_id      BIGINT      REFERENCES pages(id) ON DELETE CASCADE,
    started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at  TIMESTAMPTZ,
    ok           BOOLEAN,
    stats        JSONB       NOT NULL DEFAULT '{}',
    error        TEXT
);

CREATE INDEX job_runs_recent_idx ON job_runs (job, started_at DESC);


-- ═══════════════════════════════════════════════════════════════════════════
-- Tự cập nhật updated_at
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER pages_touch           BEFORE UPDATE ON pages           FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER scripts_touch         BEFORE UPDATE ON scripts         FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER script_messages_touch BEFORE UPDATE ON script_messages FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER send_queue_touch      BEFORE UPDATE ON send_queue      FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
