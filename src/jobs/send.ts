import type { Logger } from "pino";
import { config } from "../config/index.js";
import { sleep, isWithinSendWindow } from "../lib/time.js";
import { runJob, withJobRun, WORKER_ID, shouldStop, isMain } from "../lib/runner.js";
import type { Page, SendableJob, SendOutcome, SendErrorKind } from "../domain/types.js";
import * as pancake from "../clients/pancake.js";
import * as facebook from "../clients/facebook.js";
import * as pagesRepo from "../db/repositories/pages.repo.js";
import * as queueRepo from "../db/repositories/queue.repo.js";

/**
 * JOB SEND — lấy lượt tới hạn trong hàng đợi và gửi.
 *
 * Lịch chạy: cron mỗi 5 phút (`npm run job:send`), hoặc `--loop` để tự lặp.
 * Mỗi lượt chạy có ngân sách thời gian 4,5 phút để không chồng lên lượt sau.
 *
 * Với từng page: lấy một lô (FOR UPDATE SKIP LOCKED — nhiều worker chạy song
 * song vẫn an toàn), gửi song song trong lô, nghỉ, lấy lô tiếp. Page đang
 * 'degraded' dùng lô nhỏ hơn và nghỉ lâu hơn. Gặp lỗi cấp page (hết cước /
 * Facebook chặn) → ngưng page ngay và bỏ qua phần còn lại của page trong lượt này.
 */

const PASS_BUDGET_MS = 4.5 * 60_000;
const STUCK_MINUTES = 15;

interface PageContext {
    page: Page;
    pancakeToken: string | null;
    fbToken: string | null;
    log: Logger;
}

interface JobResult {
    outcome: SendOutcome;
    pausePage: boolean;
    slowDown: boolean;
}

// ─── Tải ảnh ──────────────────────────────────────────────────────────────────

async function downloadImage(url: string): Promise<{ buffer: Buffer; name: string; type: string } | null> {
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
        if (!res.ok) return null;
        const type = res.headers.get("content-type") ?? "image/jpeg";
        const ext = type.split("/")[1]?.replace("jpeg", "jpg") ?? "jpg";
        const name = url.split("/").pop()?.split("?")[0] || `image.${ext}`;
        return { buffer: Buffer.from(await res.arrayBuffer()), name, type };
    } catch {
        return null;
    }
}

// ─── Gửi một lượt ─────────────────────────────────────────────────────────────

const PAGE_LEVEL: ReadonlySet<SendErrorKind> = new Set(["PAGE_QUOTA", "PAGE_BLOCKED"]);
const FINAL_FOR_CUSTOMER: ReadonlySet<SendErrorKind> = new Set(["USER_UNAVAILABLE", "INVALID_RECIPIENT"]);

async function sendViaPancake(job: SendableJob, ctx: PageContext): Promise<SendOutcome | null> {
    if (!ctx.pancakeToken) return null;
    const t0 = Date.now();
    const convoId = job.conversation_id ?? `${job.fb_page_id}_${job.psid}`;
    const body = job.body.trim();
    let token = ctx.pancakeToken;

    // 1. Text
    if (body) {
        let r = await pancake.sendText(job.fb_page_id, convoId, body, token);
        if (!r.success && r.errorKind === "TOKEN_EXPIRED") {
            const fresh = await pancake.getPageToken(job.fb_page_id, true);
            if (fresh) {
                token = fresh;
                ctx.pancakeToken = fresh;
                r = await pancake.sendText(job.fb_page_id, convoId, body, token);
            }
        }
        if (!r.success) {
            return {
                success: false,
                channel: "pancake",
                errorKind: r.errorKind ?? "UNKNOWN",
                errorCode: r.errorCode,
                errorMessage: r.errorMessage,
                durationMs: Date.now() - t0,
            };
        }
    }

    // 2. Ảnh — lỗi ảnh không làm hỏng cả lượt nếu text đã đi
    let imagesFailed = 0;
    for (const url of job.media) {
        const file = await downloadImage(url);
        if (!file) {
            imagesFailed++;
            continue;
        }
        const up = await pancake.uploadImage(job.fb_page_id, file, token);
        if (!("contentId" in up)) {
            imagesFailed++;
            if (up.errorKind && PAGE_LEVEL.has(up.errorKind)) {
                return { success: body.length > 0, channel: "pancake", errorKind: up.errorKind, errorCode: up.errorCode, errorMessage: up.errorMessage, durationMs: Date.now() - t0 };
            }
            continue;
        }
        const sent = await pancake.sendImages(job.fb_page_id, convoId, [up.contentId], token);
        if (!sent.success) imagesFailed++;
        await sleep(300);
    }

    return {
        success: true,
        channel: "pancake",
        errorMessage: imagesFailed > 0 ? `Text OK, ${imagesFailed}/${job.media.length} ảnh lỗi` : undefined,
        durationMs: Date.now() - t0,
    };
}

async function sendViaFacebook(job: SendableJob, ctx: PageContext, reason: string): Promise<SendOutcome | null> {
    if (!ctx.fbToken) return null;
    if (!facebook.isValidPsid(job.psid)) {
        return { success: false, channel: "facebook", errorKind: "INVALID_RECIPIENT", errorMessage: `PSID không hợp lệ: ${job.psid}`, durationMs: 0 };
    }
    const t0 = Date.now();
    const body = job.body.trim();
    let tagUsed: string | undefined;

    if (body) {
        const r = await facebook.sendText(job.psid, body, ctx.fbToken);
        if (!r.success) {
            return {
                success: false,
                channel: "facebook",
                errorKind: r.errorKind ?? "UNKNOWN",
                errorCode: r.errorCode,
                errorMessage: `[sau Pancake: ${reason}] ${r.errorMessage ?? ""}`.slice(0, 300),
                durationMs: Date.now() - t0,
            };
        }
        tagUsed = r.tagUsed;
    }

    let imagesFailed = 0;
    for (const url of job.media) {
        const r = await facebook.sendImageUrl(job.psid, url, ctx.fbToken);
        if (!r.success) imagesFailed++;
        else tagUsed ??= r.tagUsed;
        await sleep(300);
    }

    return {
        success: true,
        channel: "facebook",
        fbTag: tagUsed,
        errorMessage: imagesFailed > 0 ? `Text OK, ${imagesFailed}/${job.media.length} ảnh lỗi` : undefined,
        durationMs: Date.now() - t0,
    };
}

export async function processJob(job: SendableJob, ctx: PageContext): Promise<JobResult> {
    const none: JobResult = { outcome: { success: false, channel: "pancake", durationMs: 0 }, pausePage: false, slowDown: false };

    if (!job.body.trim() && job.media.length === 0) {
        await queueRepo.markSkipped(job.id, "Nội dung rỗng");
        return none;
    }
    // Kiểm tra cửa sổ lần cuối ngay trước khi gửi — khách có thể vừa rơi ra sau khi PLAN chạy
    if (!isWithinSendWindow(job.last_interaction_at, config.journey.windowDays)) {
        await queueRepo.markSkipped(job.id, `Ngoài cửa sổ ${config.journey.windowDays} ngày lúc gửi`);
        return none;
    }

    // Đường chính
    let outcome = await sendViaPancake(job, ctx);

    // Đường dự phòng — chỉ khi lỗi ở cấp KHÁCH, không phải cấp PAGE
    if (!outcome || (!outcome.success && !PAGE_LEVEL.has(outcome.errorKind ?? "UNKNOWN") && !FINAL_FOR_CUSTOMER.has(outcome.errorKind ?? "UNKNOWN"))) {
        const fb = await sendViaFacebook(job, ctx, outcome?.errorMessage ?? "không có token Pancake");
        if (fb) outcome = fb;
    }

    if (!outcome) {
        outcome = { success: false, channel: "pancake", errorKind: "UNKNOWN", errorMessage: "Không có kênh nào khả dụng (thiếu token Pancake lẫn Facebook)", durationMs: 0 };
    }

    await queueRepo.writeLog(job, outcome);

    if (outcome.success) {
        await queueRepo.markSent(job.id);
        return { outcome, pausePage: false, slowDown: false };
    }

    const kind = outcome.errorKind ?? "UNKNOWN";
    const errText = `${kind}${outcome.errorCode ? ` #${outcome.errorCode}` : ""}: ${outcome.errorMessage ?? ""}`;

    if (PAGE_LEVEL.has(kind)) {
        const why = kind === "PAGE_QUOTA" ? "Pancake hết gói cước (121)" : "Facebook chặn page (#2022)";
        await pagesRepo.pause(ctx.page.id, config.health.pauseMinutes, why);
        await queueRepo.markFailed(job.id, errText, true); // trả về hàng đợi; skipLate sẽ dọn nếu quá giờ
        ctx.log.error({ kind }, `⛔ ${why} — ngưng page ${config.health.pauseMinutes} phút`);
        return { outcome, pausePage: true, slowDown: false };
    }
    if (FINAL_FOR_CUSTOMER.has(kind)) {
        await queueRepo.markFailed(job.id, errText, false);
        return { outcome, pausePage: false, slowDown: false };
    }
    if (kind === "RATE_LIMITED") {
        await queueRepo.markFailed(job.id, errText, true);
        return { outcome, pausePage: false, slowDown: true };
    }
    // NETWORK / OUT_OF_WINDOW / UNKNOWN → thử lại tới giới hạn
    const retry = kind === "NETWORK" && job.attempt_count < config.send.maxAttempts;
    await queueRepo.markFailed(job.id, errText, retry);
    return { outcome, pausePage: false, slowDown: false };
}

// ─── Một lượt chạy ────────────────────────────────────────────────────────────

export interface PassStats extends Record<string, unknown> {
    pages: number;
    picked: number;
    sent: number;
    failed: number;
    viaFacebook: number;
    pausedPages: number;
    releasedStuck: number;
    skippedLate: number;
}

async function sendForPage(page: Page, log: Logger, deadline: number, stats: PassStats): Promise<void> {
    const degraded = page.health_state === "degraded";
    let batchSize = degraded ? config.health.degradeBatchSize : config.send.batchSize;
    let delayMs = degraded ? config.health.degradeDelayMs : config.send.batchDelayMs;

    const ctx: PageContext = {
        page,
        pancakeToken: await pancake.getPageToken(page.page_id).catch(() => null),
        fbToken: await facebook.getPageToken(page.page_id, page.page_name).catch(() => null),
        log,
    };
    if (!ctx.pancakeToken && !ctx.fbToken) {
        log.error("Không có token Pancake lẫn Facebook — không gửi được gì cho page này");
        return;
    }
    if (!ctx.pancakeToken) log.warn("Không có token Pancake — chỉ dùng đường Facebook");

    for (;;) {
        if (shouldStop() || Date.now() > deadline) return;

        const jobs = await queueRepo.pickBatch(batchSize, WORKER_ID, page.id);
        if (jobs.length === 0) return;
        stats.picked += jobs.length;

        const results = await Promise.all(jobs.map((j) => processJob(j, ctx)));

        let pause = false;
        let slow = false;
        for (const r of results) {
            if (r.outcome.durationMs === 0 && !r.outcome.errorKind) continue; // bị skip, không tính
            if (r.outcome.success) {
                stats.sent++;
                if (r.outcome.channel === "facebook") stats.viaFacebook++;
            } else {
                stats.failed++;
            }
            pause ||= r.pausePage;
            slow ||= r.slowDown;
        }

        if (pause) {
            stats.pausedPages++;
            return;
        }
        if (slow && batchSize > config.health.degradeBatchSize) {
            batchSize = config.health.degradeBatchSize;
            delayMs = Math.max(delayMs, config.health.degradeDelayMs);
            log.warn("Bị giới hạn tần suất — hãm tốc cho phần còn lại của lượt này");
        }

        log.info({ sent: stats.sent, failed: stats.failed, batch: jobs.length }, "…lô xong");
        await sleep(delayMs);
    }
}

export async function runPass(log: Logger, opts: { pageId?: string | null } = {}): Promise<PassStats> {
    const stats: PassStats = { pages: 0, picked: 0, sent: 0, failed: 0, viaFacebook: 0, pausedPages: 0, releasedStuck: 0, skippedLate: 0 };
    const deadline = Date.now() + PASS_BUDGET_MS;

    stats.releasedStuck = await queueRepo.releaseStuck(STUCK_MINUTES);
    stats.skippedLate = await queueRepo.skipLate(config.send.lateWindowMin);
    const released = await pagesRepo.releaseExpiredPauses();
    if (released.length > 0) log.info({ pages: released }, "Hết hạn ngưng — cho chạy lại ở chế độ thận trọng");

    const pages = opts.pageId
        ? [await pagesRepo.findByFbPageId(opts.pageId)].filter((p): p is Page => p !== null)
        : await pagesRepo.listActive();

    for (const page of pages) {
        if (!pagesRepo.isSendable(page)) continue;
        if (Date.now() > deadline || shouldStop()) break;
        stats.pages++;
        const plog = log.child({ pageId: page.page_id, page: page.page_name, health: page.health_state });
        await sendForPage(page, plog, deadline, stats).catch((err) => {
            plog.error({ err: err instanceof Error ? err.message : String(err) }, "Lỗi khi gửi cho page — sang page tiếp");
        });
    }

    return stats;
}

// ─── Chạy độc lập ─────────────────────────────────────────────────────────────
if (isMain(import.meta.url)) {
    runJob("send", async (args, log) => {
        do {
            const stats = await withJobRun("send", undefined, log, () => runPass(log, { pageId: args.page })).catch(
                () => null
            );
            if (stats) {
                const level = stats.picked === 0 ? "debug" : "info";
                log[level](stats, stats.picked === 0 ? "Không có lượt nào tới hạn" : `Gửi ${stats.sent}/${stats.picked} thành công`);
            }
            if (args.loop && !shouldStop()) await sleep(60_000);
        } while (args.loop && !shouldStop());
    });
}
