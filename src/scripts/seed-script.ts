import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { closePool } from "../db/pool.js";
import { config } from "../config/index.js";
import * as pagesRepo from "../db/repositories/pages.repo.js";
import * as scriptsRepo from "../db/repositories/scripts.repo.js";
import { journeyTable } from "../domain/journey.js";
import { isMain } from "../lib/runner.js";

/**
 * npm run script:seed -- --page <id> --file <kich-ban.json|.txt> [--name "…"]
 *
 * Nạp 12 nội dung cho một page. Hỗ trợ 2 định dạng:
 *
 *   JSON:  [ { "label": "báo giá", "body": "…", "media": ["https://…/anh.jpg"] }, … ]
 *   TXT:   các đoạn cách nhau bằng một dòng chỉ có ---
 *          dòng đầu mỗi đoạn nếu bắt đầu bằng # thì là nhãn
 *
 * Kịch bản cũ của page bị tắt (không xoá) và kịch bản mới được bật.
 */

const USAGE = `
Cách dùng:
  npm run script:seed -- --page 123456789 --file kich-ban/saudi.json
  npm run script:seed -- --page 123456789 --file kich-ban/saudi.txt --name "Saudi tháng 9"

Định dạng .txt:
  # Báo giá
  Chào bạn, sản phẩm X đang có giá …
  ---
  # Feedback
  Đây là phản hồi của khách đã dùng …
  ---
  …
`;

export function parseFile(path: string): scriptsRepo.MessageInput[] {
    const raw = readFileSync(path, "utf-8");

    if (extname(path).toLowerCase() === ".json") {
        const data = JSON.parse(raw) as unknown;
        if (!Array.isArray(data)) throw new Error("File JSON phải là một mảng các nội dung");
        return data.map((item, i) => {
            if (typeof item === "string") return { body: item.trim() };
            if (item && typeof item === "object") {
                const o = item as Record<string, unknown>;
                const body = typeof o.body === "string" ? o.body.trim() : "";
                const media = Array.isArray(o.media) ? o.media.map(String).filter(Boolean) : [];
                const label = typeof o.label === "string" ? o.label.trim() : null;
                if (!body && media.length === 0) throw new Error(`Nội dung #${i + 1} rỗng (không có body lẫn media)`);
                return { body, media, label };
            }
            throw new Error(`Nội dung #${i + 1} không đúng định dạng`);
        });
    }

    // TXT: chia theo dòng ---
    const blocks = raw
        .split(/\r?\n---+\r?\n/)
        .map((b) => b.trim())
        .filter(Boolean);

    return blocks.map((block, i) => {
        const lines = block.split(/\r?\n/);
        let label: string | null = null;
        if (lines[0]?.startsWith("#")) {
            label = lines[0].replace(/^#+\s*/, "").trim() || null;
            lines.shift();
        }
        const body = lines.join("\n").trim();
        if (!body) throw new Error(`Đoạn #${i + 1} rỗng`);
        return { body, label, media: [] };
    });
}

async function main(): Promise<void> {
    const { values } = parseArgs({
        options: {
            page: { type: "string" },
            file: { type: "string" },
            name: { type: "string" },
            help: { type: "boolean", short: "h", default: false },
        },
    });

    if (values.help || !values.page || !values.file) {
        console.log(USAGE);
        process.exitCode = values.help ? 0 : 1;
        return;
    }

    // Đọc file TRƯỚC khi chạm DB: file hỏng thì báo ngay, không tốn kết nối
    const messages = parseFile(values.file);

    const page = await pagesRepo.findByFbPageId(values.page.trim());
    if (!page) throw new Error(`Page ${values.page} chưa có trong hệ thống — chạy npm run page:add trước.`);
    const expected = config.journey.messageCount;

    if (messages.length !== expected) {
        console.log(
            `⚠️  File có ${messages.length} nội dung, cấu hình mong đợi ${expected}.` +
                ` Vẫn nạp — công thức xoay vòng sẽ dùng ${messages.length} tin.`
        );
    }

    const name = values.name?.trim() || `${page.page_name} — ${new Date().toISOString().slice(0, 10)}`;
    const { script } = await scriptsRepo.replaceActiveScript(page.id, name, messages, {
        journeyDays: config.journey.days,
        slotsPerDay: config.journey.slotsPerDay,
    });

    console.log(`\n✅ Đã nạp kịch bản "${script.name}" cho ${page.page_name}`);
    console.log(`   ${messages.length} nội dung · hành trình ${script.journey_days} ngày × ${script.slots_per_day} khung giờ\n`);

    // In bảng lịch để người nạp nhìn thấy khách sẽ nhận gì vào lúc nào
    console.log("   Lịch một khách sẽ nhận (số = thứ tự tin trong file, tính từ 1):");
    console.log("   " + "Ngày".padEnd(8) + config.journey.slotHours.map((h) => `${h}h`.padStart(6)).join(""));
    for (const row of journeyTable({ journeyDays: script.journey_days, messageCount: messages.length })) {
        console.log(
            "   " + `Ngày ${row.day}`.padEnd(8) + row.slots.map((s) => String(s.messageIndex + 1).padStart(6)).join("")
        );
    }
    console.log();
    console.log("   Nhãn:");
    messages.forEach((m, i) => {
        const preview = m.body.replace(/\s+/g, " ").slice(0, 60);
        console.log(`   ${String(i + 1).padStart(3)}. ${(m.label ?? "").padEnd(14)} ${preview}${m.body.length > 60 ? "…" : ""}${m.media?.length ? `  [${m.media.length} ảnh]` : ""}`);
    });
    console.log();
}

// Chỉ chạy khi gọi trực tiếp — file này còn được import để dùng parseFile
if (isMain(import.meta.url)) {
    main()
        .catch((err) => {
            console.error("\n❌", err instanceof Error ? err.message : err, "\n");
            process.exitCode = 1;
        })
        .finally(() => closePool());
}
