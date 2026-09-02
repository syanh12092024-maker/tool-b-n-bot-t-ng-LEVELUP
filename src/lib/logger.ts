import pino from "pino";
import { config } from "../config/index.js";

/**
 * Log có cấu trúc. Trên VPS chạy production thì ghi JSON để đẩy vào file/journald;
 * lúc dev thì in ra cho người đọc.
 */
// Trên production ghi ĐỒNG BỘ. Mặc định pino ghi bất đồng bộ qua bộ đệm, mà các
// job theo lịch (sync/plan/send/pos/health) chạy vài chục mili-giây rồi thoát —
// tiến trình kết thúc trước khi bộ đệm kịp xả nên file log của pm2 rỗng trơn,
// đúng lúc cần soi lỗi production thì không có gì để đọc. Lượng log ở đây rất
// nhỏ nên ghi đồng bộ không ảnh hưởng gì.
export const logger = config.isProd
    ? pino(
          {
              level: config.logLevel,
              base: undefined,
              timestamp: pino.stdTimeFunctions.isoTime,
          },
          pino.destination({ sync: true })
      )
    : pino({
          level: config.logLevel,
          base: undefined, // bỏ pid/hostname cho gọn
          timestamp: pino.stdTimeFunctions.isoTime,
          transport: {
              target: "pino-pretty",
              options: {
                  colorize: true,
                  translateTime: "HH:MM:ss",
                  ignore: "pid,hostname",
              },
          },
      });

/** Logger con gắn sẵn tên job — mọi dòng log sẽ kèm trường `job`. */
export function jobLogger(job: string) {
    return logger.child({ job });
}

/** Logger con gắn sẵn page — dùng khi xử lý một page cụ thể. */
export function pageLogger(job: string, pageId: string, pageName?: string) {
    return logger.child({ job, pageId, ...(pageName ? { page: pageName } : {}) });
}
