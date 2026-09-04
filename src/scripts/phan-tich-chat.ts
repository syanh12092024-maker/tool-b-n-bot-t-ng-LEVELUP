import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { runJob, isMain } from "../lib/runner.js";
import { mapConcurrent } from "../lib/http.js";
import * as pancake from "../clients/pancake.js";
import { analyzeConversation, buildReport, type ChatReport, type ConversationFacts } from "../domain/chat-analysis.js";

/**
 * npm run chat:phan-tich -- --page <id> [--so 100]
 *
 * Đọc hội thoại THẬT của một page rồi in ra bản tóm tắt để NGƯỜI soạn nội dung bot.
 * Không dùng AI, không tốn phí — toàn bộ là đếm và khớp mẫu.
 *
 * Mọi con số đều truy ngược được: bản JSON kèm theo chứa dữ liệu thô.
 */

function bar(n: number, max: number, width = 22): string {
    const w = max > 0 ? Math.round((n / max) * width) : 0;
    return "█".repeat(Math.max(n > 0 ? 1 : 0, w)).padEnd(width, "·");
}

const LANG_NAME: Record<string, string> = {
    ar: "Ả Rập", ja: "Nhật", zh: "Trung", ko: "Hàn", th: "Thái",
    vi: "Việt", latin: "Anh / chữ Latin", unknown: "không rõ",
};

export function renderReport(r: ChatReport, pageName: string): string {
    const L: string[] = [];
    const line = (s = "") => L.push(s);
    const h = (t: string) => { line(); line(`━━━ ${t} ${"━".repeat(Math.max(0, 62 - t.length))}`); line(); };

    line();
    line(`╔${"═".repeat(66)}╗`);
    line(`║  PHÂN TÍCH HỘI THOẠI — ${pageName.slice(0, 40).padEnd(41)}║`);
    line(`╚${"═".repeat(66)}╝`);

    h("1. TỔNG QUAN");
    line(`  Hội thoại đọc được        : ${r.conversations}`);
    line(`  Có khách thực sự nhắn     : ${r.withCustomerMessage}`);
    line(`  Khách để lại SĐT          : ${r.gavePhone}  (${(r.phoneRate * 100).toFixed(1)}%)`);
    line(`  Trung bình mỗi hội thoại  : ${r.avgExchanges} lượt qua lại`);
    line(`  Hỏi giá NGAY câu đầu tiên : ${r.priceAskedFirstTurn}/${r.withCustomerMessage}` +
         ` (${((r.priceAskedFirstTurn / Math.max(1, r.withCustomerMessage)) * 100).toFixed(0)}%)`);

    h("2. KHÁCH DÙNG NGÔN NGỮ GÌ");
    const maxLang = Math.max(1, ...r.langs.map((x) => x.count));
    for (const l of r.langs) {
        line(`  ${(LANG_NAME[l.lang] ?? l.lang).padEnd(18)} ${String(l.count).padStart(4)}  ${bar(l.count, maxLang)}  ${(l.pct * 100).toFixed(0)}%`);
    }
    line();
    line(`  → Quyết định cần viết nội dung bằng tiếng gì.`);

    h("3. GIÁ NHÂN VIÊN ĐÃ BÁO CHO KHÁCH");
    if (r.prices.length === 0) line("  (không tìm thấy con số nào kèm đơn vị tiền)");
    const maxPrice = Math.max(1, ...r.prices.map((p) => p.count));
    for (const p of r.prices) {
        line(`  ${(p.currency + " " + p.amount).padEnd(18)} ${String(p.count).padStart(4)} lần  ${bar(p.count, maxPrice)}`);
    }
    line();
    line(`  → Điền thẳng vào tin báo giá, khỏi phải hỏi ai.`);

    h("4. CÂU ĐẦU TIÊN KHÁCH NHẮN (khách mở lời thế nào)");
    const maxOpen = Math.max(1, ...r.openingQuestions.map((x) => x.count));
    for (const q of r.openingQuestions) {
        line(`  ${String(q.count).padStart(4)}×  ${bar(q.count, maxOpen, 14)}  ${q.phrase}`);
    }
    line();
    line(`  → Tin đầu của bot nên trả lời thẳng những thứ này.`);

    h("5. CỤM TỪ KHÁCH HAY DÙNG NHẤT (toàn bộ hội thoại)");
    const maxAll = Math.max(1, ...r.allCustomerPhrases.map((x) => x.count));
    for (const q of r.allCustomerPhrases) {
        line(`  ${String(q.count).padStart(4)}×  ${bar(q.count, maxAll, 14)}  ${q.phrase}`);
    }
    line();
    line(`  → Đây là mối bận tâm thật của khách. Mỗi cụm xứng đáng một tin.`);

    h("6. CÂU NHÂN VIÊN LẶP LẠI NHIỀU NHẤT");
    line(`  (nói nhiều lần nghĩa là hiệu quả — dùng lại làm nội dung bot)`);
    line();
    for (const s of r.staffReplies) {
        line(`  ── ${s.count} lần ──`);
        for (const ln of s.sample.split("\n").slice(0, 4)) line(`     ${ln.slice(0, 92)}`);
        line();
    }

    h("7. ⭐ CÂU NÓI RA TRƯỚC KHI KHÁCH ĐỂ LẠI SỐ ĐIỆN THOẠI");
    if (r.linesBeforePhone.length === 0) {
        line("  (chưa đủ dữ liệu — cần thêm hội thoại có khách để lại số)");
    } else {
        line(`  Đây là câu đã CHỐT được khách. Quan trọng nhất trong cả bản này.`);
        line();
        for (const s of r.linesBeforePhone) {
            line(`  ── ${s.count} lần ──`);
            for (const ln of s.sample.split("\n").slice(0, 4)) line(`     ${ln.slice(0, 92)}`);
            line();
        }
    }

    h("8. QUẢNG CÁO ĐÃ KÉO KHÁCH VÀO");
    if (r.adTexts.length === 0) line("  (không có hội thoại nào đến từ quảng cáo)");
    for (const a of r.adTexts) {
        line(`  ── ${a.count} hội thoại ──`);
        for (const ln of a.sample.split("\n").slice(0, 8)) line(`     ${ln.slice(0, 92)}`);
        line();
    }
    line(`  → Nội dung bot nên nối tiếp lời hứa của quảng cáo, không mâu thuẫn.`);

    h("9. ⭐ VẤN ĐỀ KHIẾN KHÁCH KHÔNG CHỐT");
    if (r.objections.length === 0) {
        line("  (không phát hiện băn khoăn nào theo bộ từ khoá hiện có)");
    } else {
        line(`  Mỗi dòng dưới đây xứng đáng MỘT TIN trong kịch bản để hoá giải.`);
        line();
        const maxObj = Math.max(1, ...r.objections.map((o) => o.count));
        for (const o of r.objections) {
            line(`  ${String(o.count).padStart(3)} hội thoại (${(o.pct * 100).toFixed(0).padStart(2)}%)  ${bar(o.count, maxObj, 16)}  ${o.label}`);
        }
        line();
        line(`  ── Trích dẫn thật ──`);
        for (const o of r.objections.slice(0, 6)) {
            line();
            line(`  【${o.label}】`);
            for (const sm of o.samples) line(`     "${sm}"`);
        }
    }

    h("10. TIN DÀI NHẤT CỦA KHÁCH (thường là băn khoăn thật)");
    for (const t of r.longestCustomerMessages) {
        line(`  • ${t.replace(/\n/g, " ").slice(0, 150)}`);
    }

    line();
    line("─".repeat(68));
    line("  Không dùng AI. Mọi con số ở trên đếm từ hội thoại thật.");
    line("─".repeat(68));
    line();
    return L.join("\n");
}

if (isMain(import.meta.url)) {
    runJob("chat-phan-tich", async (args, log) => {
        const pageId = args.page;
        if (!pageId) {
            console.error("\n❌ Thiếu --page. Ví dụ:\n   npm run chat:phan-tich -- --page 1163618183501879\n");
            process.exitCode = 1;
            return;
        }
        const want = args.so ?? 100;

        log.info({ pageId, want }, "Đang lấy danh sách hội thoại…");
        const scan = await pancake.scanConversations(pageId, { maxWindows: 2 });
        const convs = scan.customers.slice(0, want);
        if (convs.length === 0) {
            console.error("\n❌ Page này không có hội thoại nào trong 8 tuần gần đây.\n");
            process.exitCode = 1;
            return;
        }

        log.info({ found: scan.customers.length, doc: convs.length }, "Đang đọc nội dung từng hội thoại…");
        let done = 0;
        const facts = await mapConcurrent(convs, 4, async (c): Promise<ConversationFacts | null> => {
            if (!c.conversationId) return null;
            const msgs = await pancake.fetchMessages(pageId, c.conversationId);
            if (++done % 25 === 0) log.info({ done, total: convs.length }, "…đang đọc");
            return msgs.length ? analyzeConversation(msgs) : null;
        });

        const usable = facts.filter((f): f is ConversationFacts => f !== null);
        const report = buildReport(usable);
        const pageName = (await pancake.listPages()).find((p) => p.pageId === pageId)?.name ?? pageId;

        const text = renderReport(report, pageName);
        console.log(text);

        if (!existsSync("bao-cao")) mkdirSync("bao-cao", { recursive: true });
        const stamp = new Date().toISOString().slice(0, 10);
        writeFileSync(`bao-cao/${pageId}-${stamp}.txt`, text, "utf-8");
        writeFileSync(`bao-cao/${pageId}-${stamp}.json`, JSON.stringify(report, null, 2), "utf-8");
        console.log(`  Đã lưu: bao-cao/${pageId}-${stamp}.txt  (và .json để tra số liệu thô)\n`);
    });
}
