/** Kiểu dữ liệu dùng chung giữa các tầng. Khớp 1-1 với schema trong migrations/. */

export type PageHealthState = "ok" | "degraded" | "paused";
export type CustomerStatus = "active" | "converted" | "opted_out" | "expired";
export type QueueState = "queued" | "sending" | "sent" | "failed" | "skipped";
export type SendChannel = "pancake" | "facebook";
export type CustomerEventType = "entered" | "replied" | "ordered" | "opted_out" | "expired" | "restarted";

/** Phân loại lỗi gửi — quyết định hệ thống phản ứng thế nào. */
export type SendErrorKind =
    | "PAGE_QUOTA" // Pancake hết gói cước (121) → ngưng cả page
    | "PAGE_BLOCKED" // Facebook chặn page (#2022) → ngưng cả page
    | "OUT_OF_WINDOW" // ngoài cửa sổ 24h/7 ngày (#10) → thử kênh khác
    | "USER_UNAVAILABLE" // khách chặn tin / vô hiệu hoá (#551) → bỏ qua khách này
    | "TOKEN_EXPIRED" // token hỏng (105 / #190) → làm mới rồi thử lại
    | "RATE_LIMITED" // bị giới hạn tần suất (#613) → hãm tốc
    | "INVALID_RECIPIENT" // PSID sai định dạng → không bao giờ gửi được
    | "NETWORK" // timeout, đứt mạng → thử lại
    | "UNKNOWN";

export interface Page {
    id: number;
    page_id: string;
    page_name: string;
    market: string;
    utc_offset: number;
    pancake_shop_id: string | null;
    is_active: boolean;
    health_state: PageHealthState;
    paused_until: Date | null;
    pause_reason: string | null;
    pause_count_24h: number;
    activated_at: Date | null;
    ramp_percent: number;
    last_synced_at: Date | null;
    last_planned_at: Date | null;
}

export interface Script {
    id: number;
    page_id: number;
    name: string;
    journey_days: number;
    slots_per_day: number;
    message_count: number;
    is_active: boolean;
}

export interface ScriptMessage {
    id: number;
    script_id: number;
    order_index: number;
    label: string | null;
    body: string;
    media: string[];
}

export interface Customer {
    id: number;
    page_id: number;
    psid: string;
    conversation_id: string | null;
    name: string | null;
    phone: string | null;
    order_count: number;
    tags: string[];
    first_seen_at: Date;
    last_interaction_at: Date;
    journey_day: number;
    journey_count: number;
    status: CustomerStatus;
    stop_reason: string | null;
    stopped_at: Date | null;
    /** Số đơn POS lúc khách vào chuỗi. NULL = chưa đối chiếu POS lần nào. */
    order_count_baseline: number | null;
    pos_checked_at: Date | null;
}

/** Khách vừa quét được từ Pancake, chưa vào DB. */
export interface SyncedCustomer {
    psid: string;
    conversationId: string | null;
    name: string | null;
    phone: string | null;
    orderCount: number;
    tags: string[];
    lastInteractionAt: Date;
}

export interface QueueJob {
    id: number;
    customer_id: number;
    page_id: number;
    script_message_id: number | null;
    journey_day: number;
    slot_index: number;
    scheduled_at: Date;
    state: QueueState;
    attempt_count: number;
    /** true = người dùng bấm gửi từ giao diện, không thuộc chuỗi nuôi dưỡng */
    manual?: boolean;
}

/** Một job kèm đủ dữ liệu để gửi, không cần truy vấn thêm. */
export interface SendableJob extends QueueJob {
    psid: string;
    conversation_id: string | null;
    customer_name: string | null;
    last_interaction_at: Date;
    fb_page_id: string;
    page_name: string;
    body: string;
    media: string[];
}

export interface SendOutcome {
    success: boolean;
    channel: SendChannel;
    fbTag?: string;
    errorKind?: SendErrorKind;
    errorCode?: string;
    errorMessage?: string;
    durationMs: number;
}
