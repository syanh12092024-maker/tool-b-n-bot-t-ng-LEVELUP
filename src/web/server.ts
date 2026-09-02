import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { jobLogger } from "../lib/logger.js";
import { closePool } from "../db/pool.js";
import { isMain } from "../lib/runner.js";
import * as views from "./views.js";
import { layout, esc } from "./html.js";

/**
 * Dashboard — máy chủ HTTP chỉ ĐỌC.
 *
 * Không có nút nào ghi dữ liệu: mọi thay đổi (thêm page, nạp kịch bản, bật/tắt)
 * đều qua CLI. Như vậy dashboard không thể làm hỏng chiến dịch đang chạy, và
 * không cần lo CSRF hay xác thực ghi.
 *
 *   npm run web           → http://localhost:8090
 */

const log = jobLogger("web");
const PORT = Number(process.env.DASHBOARD_PORT ?? 8090);
const USER = process.env.DASHBOARD_USER || "admin";
const PASS = process.env.DASHBOARD_PASSWORD || "";

/** So sánh chuỗi không lộ thời gian — tránh dò mật khẩu theo độ trễ. */
function safeEqual(a: string, b: string): boolean {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
}

function authorized(req: IncomingMessage): boolean {
    if (!PASS) return true; // chưa đặt mật khẩu → mở (chỉ nên dùng khi chạy local)
    const header = req.headers.authorization ?? "";
    if (!header.startsWith("Basic ")) return false;
    const [user = "", ...rest] = Buffer.from(header.slice(6), "base64").toString("utf-8").split(":");
    return safeEqual(user, USER) && safeEqual(rest.join(":"), PASS);
}

function html(res: ServerResponse, status: number, body: string): void {
    res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(body);
}

function notFound(res: ServerResponse, what = "Không có trang này"): void {
    html(res, 404, layout("Không tìm thấy", "", `<h1>404</h1><p class="empty">${esc(what)}</p><p><a href="/">← Về tổng quan</a></p>`));
}

export function createDashboardServer() {
    return createServer(async (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const path = url.pathname;

        if (req.method !== "GET") {
            res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
            return res.end("Dashboard chỉ đọc — mọi thay đổi làm qua CLI");
        }

        if (!authorized(req)) {
            res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Ban bot TALPHA", charset="UTF-8"' });
            return res.end("Cần đăng nhập");
        }

        try {
            if (path === "/") return html(res, 200, await views.home());
            if (path === "/report") {
                const p = url.searchParams.get("page");
                return html(res, 200, await views.report(p ? Number(p) : undefined));
            }
            if (path === "/jobs") return html(res, 200, await views.jobs());
            if (path === "/search") return html(res, 200, await views.search(url.searchParams.get("q") ?? ""));

            const script = /^\/page\/(\d+)\/script$/.exec(path);
            if (script) {
                const page = await views.scriptView(Number(script[1]));
                return page ? html(res, 200, page) : notFound(res, "Không có page này");
            }
            const page = /^\/page\/(\d+)$/.exec(path);
            if (page) {
                const body = await views.pageDetail(Number(page[1]));
                return body ? html(res, 200, body) : notFound(res, "Không có page này");
            }
            const cust = /^\/customer\/(\d+)$/.exec(path);
            if (cust) {
                const body = await views.customerView(Number(cust[1]));
                return body ? html(res, 200, body) : notFound(res, "Không có khách này");
            }
            if (path === "/healthz") {
                res.writeHead(200, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ ok: true }));
            }

            return notFound(res);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.error({ path, err: msg }, "Lỗi khi dựng trang");
            return html(res, 500, layout("Lỗi", "", `<h1>Lỗi máy chủ</h1><p class="err">${esc(msg)}</p><p><a href="/">← Về tổng quan</a></p>`));
        }
    });
}

if (isMain(import.meta.url)) {
    const server = createDashboardServer();
    server.listen(PORT, () => {
        log.info({ port: PORT, secured: Boolean(PASS) }, `Dashboard: http://localhost:${PORT}`);
        if (!PASS) log.warn("DASHBOARD_PASSWORD trống — ai vào được cổng này cũng xem được dữ liệu khách. Đặt mật khẩu trước khi mở ra Internet.");
    });

    for (const sig of ["SIGINT", "SIGTERM"] as const) {
        process.on(sig, () => {
            log.info({ sig }, "Đang tắt dashboard");
            server.close(() => closePool().then(() => process.exit(0)));
            setTimeout(() => process.exit(0), 5000).unref();
        });
    }
}
