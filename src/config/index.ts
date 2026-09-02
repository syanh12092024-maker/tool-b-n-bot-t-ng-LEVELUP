import "dotenv/config";
import { z } from "zod";

/**
 * Cấu hình đọc từ biến môi trường, kiểm tra kiểu ngay khi khởi động.
 *
 * Nguyên tắc: thà chết lúc khởi động với thông báo rõ ràng còn hơn chạy được
 * rồi gửi sai cho khách hàng thật. Mọi giá trị đều có mặc định an toàn, trừ
 * các bí mật (token, DATABASE_URL) thì bắt buộc phải có.
 */

const bool = (def: boolean) =>
    z
        .string()
        .optional()
        .transform((v) => (v === undefined || v === "" ? def : v.toLowerCase() === "true" || v === "1"));

const int = (def: number) =>
    z
        .string()
        .optional()
        .transform((v) => (v === undefined || v === "" ? def : Number(v)))
        .pipe(z.number().int());

const num = (def: number) =>
    z
        .string()
        .optional()
        .transform((v) => (v === undefined || v === "" ? def : Number(v)))
        .pipe(z.number());

const str = (def: string) =>
    z
        .string()
        .optional()
        .transform((v) => (v === undefined || v === "" ? def : v));

const schema = z.object({
    NODE_ENV: str("development"),
    LOG_LEVEL: str("info"),

    // ─── Database ────────────────────────────────────────────────────────
    DATABASE_URL: z.string().min(1, "DATABASE_URL bắt buộc phải có"),
    DATABASE_POOL_MAX: int(10),

    // ─── Pancake ─────────────────────────────────────────────────────────
    PANCAKE_CRM_TOKEN: z.string().min(1, "PANCAKE_CRM_TOKEN bắt buộc phải có"),
    PANCAKE_API_URL: str("https://pages.fm/api/v1"),
    PANCAKE_PUBLIC_API_URL: str("https://pages.fm/api/public_api/v1"),

    // ─── Facebook (dự phòng) ─────────────────────────────────────────────
    FB_USER_ACCESS_TOKEN: str(""),
    FB_APP_SECRET: str(""),
    FB_GRAPH_VERSION: str("v21.0"),

    // ─── Hành trình ──────────────────────────────────────────────────────
    JOURNEY_DAYS: int(7).pipe(z.number().min(1).max(7)),
    SLOTS_PER_DAY: int(4).pipe(z.number().min(1).max(4)),
    MESSAGE_COUNT: int(12).pipe(z.number().min(1).max(28)),
    SEND_SLOT_HOURS: str("6,11,17,21"),
    SEND_WINDOW_DAYS: int(7).pipe(z.number().min(1).max(7)),
    STOP_ON_REPLY: bool(false),

    // ─── Nhịp gửi ────────────────────────────────────────────────────────
    SEND_BATCH_SIZE: int(8).pipe(z.number().min(1).max(50)),
    SEND_BATCH_DELAY_MS: int(2500),
    SEND_LATE_WINDOW_MIN: int(60),
    SEND_MAX_ATTEMPTS: int(3).pipe(z.number().min(1).max(10)),

    // ─── Sức khoẻ page ───────────────────────────────────────────────────
    HEALTH_DEGRADE_ERROR_RATE: num(0.3).pipe(z.number().min(0).max(1)),
    HEALTH_DEGRADE_BATCH_SIZE: int(4),
    HEALTH_DEGRADE_DELAY_MS: int(10_000),
    HEALTH_PAUSE_MINUTES: int(30),
    HEALTH_ESCALATE_AFTER_PAUSES: int(3),
    HEALTH_ESCALATE_HOURS: int(6),
    HEALTH_MIN_SAMPLE: int(20),

    // ─── Khởi động dần ───────────────────────────────────────────────────
    RAMP_UP_DAYS: int(3),
    RAMP_UP_START_PERCENT: int(25).pipe(z.number().min(1).max(100)),

    // ─── Đồng bộ ─────────────────────────────────────────────────────────
    SYNC_HOUR_LOCAL: int(3).pipe(z.number().min(0).max(23)),
    SYNC_MAX_WINDOWS: int(36),
    SYNC_MAX_CUSTOMERS_PER_PAGE: int(20_000),
    SYNC_PAGE_CONCURRENCY: int(4).pipe(z.number().min(1).max(10)),

    // ─── Webhook ─────────────────────────────────────────────────────────
    WEBHOOK_PORT: int(8080),
    WEBHOOK_SECRET: str(""),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  • ${i.path.join(".")}: ${i.message}`);
    console.error("\n❌ Cấu hình không hợp lệ — kiểm tra lại file .env:\n" + lines.join("\n") + "\n");
    process.exit(1);
}

const env = parsed.data;

/** Giờ bắn trong ngày, ví dụ [6, 11, 17, 21]. */
const slotHours = env.SEND_SLOT_HOURS.split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 23);

if (slotHours.length !== env.SLOTS_PER_DAY) {
    console.error(
        `\n❌ SEND_SLOT_HOURS có ${slotHours.length} giờ nhưng SLOTS_PER_DAY = ${env.SLOTS_PER_DAY}.` +
            `\n   Hai giá trị này phải khớp nhau.\n`
    );
    process.exit(1);
}

export const config = {
    env: env.NODE_ENV,
    isProd: env.NODE_ENV === "production",
    logLevel: env.LOG_LEVEL,

    db: {
        url: env.DATABASE_URL,
        poolMax: env.DATABASE_POOL_MAX,
    },

    pancake: {
        token: env.PANCAKE_CRM_TOKEN,
        apiUrl: env.PANCAKE_API_URL,
        publicApiUrl: env.PANCAKE_PUBLIC_API_URL,
    },

    facebook: {
        userToken: env.FB_USER_ACCESS_TOKEN,
        appSecret: env.FB_APP_SECRET,
        graphVersion: env.FB_GRAPH_VERSION,
        get enabled() {
            return env.FB_USER_ACCESS_TOKEN.length > 0;
        },
    },

    journey: {
        days: env.JOURNEY_DAYS,
        slotsPerDay: env.SLOTS_PER_DAY,
        messageCount: env.MESSAGE_COUNT,
        slotHours,
        /** Tổng số lượt gửi của một hành trình đầy đủ. */
        totalSlots: env.JOURNEY_DAYS * env.SLOTS_PER_DAY,
        /** Cửa sổ Facebook cho phép chủ động nhắn (HUMAN_AGENT). */
        windowDays: env.SEND_WINDOW_DAYS,
        stopOnReply: env.STOP_ON_REPLY,
    },

    send: {
        batchSize: env.SEND_BATCH_SIZE,
        batchDelayMs: env.SEND_BATCH_DELAY_MS,
        lateWindowMin: env.SEND_LATE_WINDOW_MIN,
        maxAttempts: env.SEND_MAX_ATTEMPTS,
    },

    health: {
        degradeErrorRate: env.HEALTH_DEGRADE_ERROR_RATE,
        degradeBatchSize: env.HEALTH_DEGRADE_BATCH_SIZE,
        degradeDelayMs: env.HEALTH_DEGRADE_DELAY_MS,
        pauseMinutes: env.HEALTH_PAUSE_MINUTES,
        escalateAfterPauses: env.HEALTH_ESCALATE_AFTER_PAUSES,
        escalateHours: env.HEALTH_ESCALATE_HOURS,
        minSample: env.HEALTH_MIN_SAMPLE,
    },

    rampUp: {
        days: env.RAMP_UP_DAYS,
        startPercent: env.RAMP_UP_START_PERCENT,
    },

    sync: {
        hourLocal: env.SYNC_HOUR_LOCAL,
        maxWindows: env.SYNC_MAX_WINDOWS,
        maxCustomersPerPage: env.SYNC_MAX_CUSTOMERS_PER_PAGE,
        pageConcurrency: env.SYNC_PAGE_CONCURRENCY,
    },

    webhook: {
        port: env.WEBHOOK_PORT,
        secret: env.WEBHOOK_SECRET,
    },
} as const;

export type Config = typeof config;
