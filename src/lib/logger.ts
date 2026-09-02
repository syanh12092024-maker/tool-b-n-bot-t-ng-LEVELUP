import pino from "pino";
import { config } from "../config/index.js";

/**
 * Log có cấu trúc. Trên VPS chạy production thì ghi JSON để đẩy vào file/journald;
 * lúc dev thì in ra cho người đọc.
 */
export const logger = pino({
    level: config.logLevel,
    base: undefined, // bỏ pid/hostname cho gọn
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(config.isProd
        ? {}
        : {
              transport: {
                  target: "pino-pretty",
                  options: {
                      colorize: true,
                      translateTime: "HH:MM:ss",
                      ignore: "pid,hostname",
                  },
              },
          }),
});

/** Logger con gắn sẵn tên job — mọi dòng log sẽ kèm trường `job`. */
export function jobLogger(job: string) {
    return logger.child({ job });
}

/** Logger con gắn sẵn page — dùng khi xử lý một page cụ thể. */
export function pageLogger(job: string, pageId: string, pageName?: string) {
    return logger.child({ job, pageId, ...(pageName ? { page: pageName } : {}) });
}
