import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { config } from "../config/index.js";
import { jobLogger } from "../lib/logger.js";
import { closePool } from "../db/pool.js";
import { matchOptOut } from "../domain/rules.js";
import * as pagesRepo from "../db/repositories/pages.repo.js";
import * as customersRepo from "../db/repositories/customers.repo.js";
import * as queueRepo from "../db/repositories/queue.repo.js";

/**
 * JOB WEBHOOK — máy chủ HTTP luôn chạy, nhận sự kiện từ bên ngoài.
 *
 *   POST /webhook/message   { page_id, psid, text }            khách vừa nhắn
 *   POST /webhook/order     { page_id, psid, order_id? }       khách vừa chốt đơn
 *   GET  /health                                               kiểm tra sống
 *
 * Bảo vệ bằng header  x-webhook-secret: <WEBHOOK_SECRET>  (bỏ trống = không kiểm).
 *
 * Định dạng payload cố tình đơn giản và trung lập: Pancake và Facebook gửi
 * webhook theo cấu trúc khác nhau, nên đặt một lớp chuyển đổi (n8n, một hàm
 * nhỏ, hoặc bộ đọc payload ở dưới) trước khi tới đây. Bộ đọc bên dưới cố gắng
 * nhận cả vài dạng phổ biến của Pancake.
 */

const log = jobLogger("webhook");

interface MessageEvent {
    pageId: string;
    psid: string;
    text: string;
}
interface OrderEvent {
    pageId: string;
    psid: string;
    orderId: string | null;
}

function str(v: unknown): string {
    return v === undefined || v === null ? "" : String(v);
}

/** Đọc payload — chấp nhận dạng phẳng của mình lẫn vài dạng lồng của Pancake. */
function parseMessage(body: Record<string, unknown>): MessageEvent | null {
    const pageId = str(body.page_id ?? (body.page as Record<string, unknown> | undefined)?.id);
    const psid = str(
        body.psid ??
            body.from_psid ??
            (body.from as Record<string, unknown> | undefined)?.id ??
            (body.sender as Record<string, unknown> | undefined)?.id
    );
    const text = str(body.text ?? body.message ?? (body.message as Record<string, unknown> | undefined)?.text ?? body.snippet);
    if (!pageId || !psid) return null;
    return { pageId, psid, text };
}

function parseOrder(body: Record<string, unknown>): OrderEvent | null {
    const pageId = str(body.page_id);
    const psid = str(body.psid ?? body.fb_id?.toString().split("_").slice(1).join("_"));
    if (!pageId || !psid) return null;
    return { pageId, psid, orderId: body.order_id ? str(body.order_id) : null };
}

// ─── Xử lý sự kiện ────────────────────────────────────────────────────────────

async function onMessage(ev: MessageEvent): Promise<string> {
    const page = await pagesRepo.findByFbPageId(ev.pageId);
    if (!page) return "page không trong hệ thống";
    const cust = await customersRepo.findByPsid(page.id, ev.psid);
    if (!cust) return "khách chưa có trong tệp (sẽ vào ở lần sync tới)";

    await customersRepo.touchInteraction(cust.id);

    const keyword = matchOptOut(ev.text);
    if (keyword) {
        await customersRepo.addOptOut(page.id, ev.psid, keyword, ev.text);
        const changed = await customersRepo.stop(cust.id, "opted_out", `Khách từ chối: "${keyword}"`);
        const cancelled = await queueRepo.cancelPendingForCustomer(cust.id, "Khách từ chối nhận tin");
        await customersRepo.recordEvent(cust.id, page.id, "opted_out", cust.journey_day, { keyword, text: ev.text.slice(0, 200) });
        log.warn({ pageId: ev.pageId, psid: ev.psid, keyword, cancelled }, "Khách từ chối — đã chặn vĩnh viễn");
        return changed ? "đã chặn" : "đã trong danh sách chặn";
    }

    await customersRepo.recordEvent(cust.id, page.id, "replied", cust.journey_day, { text: ev.text.slice(0, 200) });

    if (config.journey.stopOnReply && cust.status === "active") {
        // STOP_ON_REPLY=true: khách nhắn lại là dừng chuỗi, chuyển cho người chăm
        await customersRepo.stop(cust.id, "converted", "Khách đã trả lời — dừng theo STOP_ON_REPLY");
        const cancelled = await queueRepo.cancelPendingForCustomer(cust.id, "Khách đã trả lời");
        log.info({ pageId: ev.pageId, psid: ev.psid, cancelled }, "Khách trả lời — dừng chuỗi (STOP_ON_REPLY)");
        return "đã dừng chuỗi";
    }
    return "đã ghi nhận, chuỗi tiếp tục";
}

async function onOrder(ev: OrderEvent): Promise<string> {
    const page = await pagesRepo.findByFbPageId(ev.pageId);
    if (!page) return "page không trong hệ thống";
    const cust = await customersRepo.findByPsid(page.id, ev.psid);
    if (!cust) return "khách chưa có trong tệp";

    const changed = await customersRepo.stop(cust.id, "converted", `Đã chốt đơn${ev.orderId ? " " + ev.orderId : ""}`);
    const cancelled = await queueRepo.cancelPendingForCustomer(cust.id, "Khách đã chốt đơn");
    await customersRepo.recordEvent(cust.id, page.id, "ordered", cust.journey_day, { orderId: ev.orderId });
    log.info({ pageId: ev.pageId, psid: ev.psid, orderId: ev.orderId, journeyDay: cust.journey_day, cancelled }, "🎉 Chốt đơn — dừng chuỗi");
    return changed ? "đã dừng chuỗi" : "khách đã dừng từ trước";
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on("data", (c: Buffer) => {
            size += c.length;
            if (size > 256 * 1024) {
                reject(new Error("Payload quá lớn"));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on("end", () => {
            try {
                const raw = Buffer.concat(chunks).toString("utf-8");
                resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
            } catch {
                reject(new Error("Body không phải JSON"));
            }
        });
        req.on("error", reject);
    });
}

function send(res: ServerResponse, status: number, body: Record<string, unknown>): void {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
    const url = req.url ?? "/";

    if (req.method === "GET" && url === "/health") {
        return send(res, 200, { ok: true, service: "banbot-webhook", time: new Date().toISOString() });
    }

    if (req.method !== "POST") return send(res, 405, { error: "Chỉ nhận POST" });

    if (config.webhook.secret) {
        const given = req.headers["x-webhook-secret"];
        if (given !== config.webhook.secret) {
            log.warn({ url, ip: req.socket.remoteAddress }, "Sai secret");
            return send(res, 401, { error: "Sai x-webhook-secret" });
        }
    }

    try {
        const body = await readBody(req);
        if (url === "/webhook/message") {
            const ev = parseMessage(body);
            if (!ev) return send(res, 400, { error: "Thiếu page_id hoặc psid" });
            return send(res, 200, { ok: true, result: await onMessage(ev) });
        }
        if (url === "/webhook/order") {
            const ev = parseOrder(body);
            if (!ev) return send(res, 400, { error: "Thiếu page_id hoặc psid" });
            return send(res, 200, { ok: true, result: await onOrder(ev) });
        }
        return send(res, 404, { error: "Không có đường dẫn này" });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ url, err: msg }, "Xử lý webhook lỗi");
        return send(res, 500, { error: msg });
    }
});

server.listen(config.webhook.port, () => {
    log.info({ port: config.webhook.port, secured: Boolean(config.webhook.secret), stopOnReply: config.journey.stopOnReply }, "Webhook đang nghe");
    if (!config.webhook.secret) log.warn("WEBHOOK_SECRET trống — ai cũng gọi được. Đặt secret trước khi mở ra Internet.");
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
        log.info({ sig }, "Đang tắt webhook");
        server.close(() => closePool().then(() => process.exit(0)));
        setTimeout(() => process.exit(0), 5000).unref();
    });
}
