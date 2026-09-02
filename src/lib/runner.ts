import { parseArgs } from "node:util";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { closePool } from "../db/pool.js";
import { startJobRun, finishJobRun } from "../db/repositories/health.repo.js";
import { jobLogger } from "./logger.js";
import type { Logger } from "pino";

/**
 * Khung chạy chung cho mọi job: đọc tham số, ghi job_runs, đóng pool khi xong.
 * Mỗi job chỉ cần lo phần nghiệp vụ.
 */

export interface JobArgs {
    /** --page <fbPageId>: chỉ xử lý một page */
    page: string | null;
    /** --force: bỏ qua kiểm tra giờ/ngày, chạy luôn */
    force: boolean;
    /** --loop: chạy lặp liên tục (dùng cho job send khi không có cron ngoài) */
    loop: boolean;
    /** --dry-run: tính toán nhưng không ghi/gửi */
    dryRun: boolean;
}

export function parseJobArgs(): JobArgs {
    const { values } = parseArgs({
        options: {
            page: { type: "string" },
            force: { type: "boolean", default: false },
            loop: { type: "boolean", default: false },
            "dry-run": { type: "boolean", default: false },
        },
        strict: false,
    });
    return {
        page: typeof values.page === "string" ? values.page.trim() : null,
        force: values.force === true,
        loop: values.loop === true,
        dryRun: values["dry-run"] === true,
    };
}

export const WORKER_ID = `${hostname()}#${process.pid}`;

/**
 * Bọc một đoạn việc trong job_runs: ghi bắt đầu, ghi kết thúc kèm thống kê,
 * ghi lỗi nếu ném ra. Không nuốt lỗi — caller quyết định làm gì tiếp.
 */
export async function withJobRun<T extends Record<string, unknown>>(
    job: string,
    pageDbId: number | undefined,
    log: Logger,
    fn: () => Promise<T>
): Promise<T> {
    const runId = await startJobRun(job, pageDbId);
    const t0 = Date.now();
    try {
        const stats = await fn();
        await finishJobRun(runId, true, { ...stats, ms: Date.now() - t0 });
        return stats;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await finishJobRun(runId, false, { ms: Date.now() - t0 }, msg).catch(() => {});
        log.error({ err: msg }, "Job thất bại");
        throw err;
    }
}

/** Chạy main() của một job rồi đóng pool, thoát đúng mã. */
export function runJob(name: string, main: (args: JobArgs, log: Logger) => Promise<void>): void {
    const log = jobLogger(name);
    const args = parseJobArgs();

    let stopping = false;
    const onSignal = (sig: string) => {
        if (stopping) return;
        stopping = true;
        log.warn({ sig }, "Nhận tín hiệu dừng — đợi lô hiện tại xong");
        process.exitCode = 0;
    };
    process.on("SIGINT", () => onSignal("SIGINT"));
    process.on("SIGTERM", () => onSignal("SIGTERM"));

    main(args, log)
        .then(() => closePool())
        .then(() => process.exit(process.exitCode ?? 0))
        .catch(async (err) => {
            log.fatal({ err: err instanceof Error ? err.stack ?? err.message : String(err) }, "Job sập");
            await closePool().catch(() => {});
            process.exit(1);
        });
}

/** Cho job biết có đang bị yêu cầu dừng không. */
export function shouldStop(): boolean {
    return process.exitCode !== undefined;
}

/**
 * File này có đang được chạy trực tiếp (không phải import) không?
 * So sánh đường dẫn thật thay vì so chuỗi URL: thư mục có dấu tiếng Việt hoặc
 * khoảng trắng sẽ bị mã hoá %XX trong import.meta.url và so chuỗi thô sẽ sai.
 */
export function isMain(metaUrl: string): boolean {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    try {
        return fileURLToPath(metaUrl) === resolve(argv1);
    } catch {
        return false;
    }
}
