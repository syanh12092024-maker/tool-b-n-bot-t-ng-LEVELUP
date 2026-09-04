import { query, queryOne, withTransaction } from "../pool.js";
import type { Script, ScriptMessage } from "../../domain/types.js";
import { config } from "../../config/index.js";

/** Kịch bản nuôi dưỡng và 12 nội dung của nó. */

const SCRIPT_COLS = `id, page_id, name, journey_days, slots_per_day, message_count, is_active`;
const MSG_COLS = `id, script_id, order_index, label, body, media`;

export function activeScriptForPage(pageDbId: number): Promise<Script | null> {
    return queryOne<Script>(`SELECT ${SCRIPT_COLS} FROM scripts WHERE page_id = $1 AND is_active`, [pageDbId]);
}

export function messagesForScript(scriptId: number): Promise<ScriptMessage[]> {
    return query<ScriptMessage>(
        `SELECT ${MSG_COLS} FROM script_messages WHERE script_id = $1 ORDER BY order_index`,
        [scriptId]
    );
}

export interface MessageInput {
    label?: string | null;
    body: string;
    media?: string[];
}

/**
 * Tạo hoặc thay kịch bản đang bật của page bằng bộ nội dung mới.
 * Kịch bản cũ (nếu có) bị tắt chứ không xoá — send_log còn trỏ tới nội dung cũ.
 */
export async function replaceActiveScript(
    pageDbId: number,
    name: string,
    messages: MessageInput[],
    opts: { journeyDays: number; slotsPerDay: number }
): Promise<{ script: Script; messageCount: number }> {
    if (messages.length === 0) throw new Error("Kịch bản phải có ít nhất 1 nội dung");

    return withTransaction(async (c) => {
        await c.query(`UPDATE scripts SET is_active = FALSE WHERE page_id = $1 AND is_active`, [pageDbId]);

        const created = await c.query<Script>(
            `INSERT INTO scripts (page_id, name, journey_days, slots_per_day, message_count, is_active)
             VALUES ($1, $2, $3, $4, $5, TRUE)
             RETURNING ${SCRIPT_COLS}`,
            [pageDbId, name, opts.journeyDays, opts.slotsPerDay, messages.length]
        );
        const script = created.rows[0];
        if (!script) throw new Error("Không tạo được kịch bản");

        for (let i = 0; i < messages.length; i++) {
            const m = messages[i];
            if (!m) continue;
            await c.query(
                `INSERT INTO script_messages (script_id, order_index, label, body, media)
                 VALUES ($1, $2, $3, $4, $5)`,
                [script.id, i, m.label ?? null, m.body, m.media ?? []]
            );
        }

        return { script, messageCount: messages.length };
    });
}

/** Sửa một nội dung tại chỗ — dùng cho dashboard sau này. */
export async function updateMessage(id: number, patch: Partial<MessageInput>): Promise<void> {
    await query(
        `UPDATE script_messages
            SET label = COALESCE($2, label),
                body  = COALESCE($3, body),
                media = COALESCE($4, media)
          WHERE id = $1`,
        [id, patch.label ?? null, patch.body ?? null, patch.media ?? null]
    );
}

/**
 * Sửa nội dung kịch bản đang bật, GIỮ NGUYÊN id của từng tin.
 *
 * Khác với replaceActiveScript (tạo kịch bản mới, tắt bản cũ): hàm này dùng cho
 * việc sửa chữ trên dashboard. Giữ nguyên script_message_id là điều bắt buộc —
 * send_log và send_queue đang trỏ vào đó, tạo bản mới sẽ làm báo cáo "tin nào ra
 * đơn" mất hết lịch sử của tin cũ.
 */
export async function updateMessageBodies(
    scriptId: number,
    edits: Array<{ orderIndex: number; body: string; media: string[]; label?: string | null }>
): Promise<number> {
    if (edits.length === 0) return 0;

    return withTransaction(async (client) => {
        let changed = 0;
        for (const e of edits) {
            const body = e.body.trim();
            const media = e.media.filter((u) => u.trim());
            // Ràng buộc CHECK ở DB cũng chặn, nhưng báo lỗi ở đây thì rõ hơn cho người dùng
            if (!body && media.length === 0) {
                throw new Error(`Tin số ${e.orderIndex + 1} bị bỏ trống — mỗi tin phải có chữ hoặc ảnh`);
            }
            const res = await client.query(
                `UPDATE script_messages
                    SET body = $3, media = $4, label = COALESCE($5, label)
                  WHERE script_id = $1 AND order_index = $2`,
                [scriptId, e.orderIndex, body, media, e.label ?? null]
            );
            changed += res.rowCount ?? 0;
        }
        return changed;
    });
}

// ─── Kết quả phân tích hội thoại ──────────────────────────────────────────────

export interface StoredAnalysis {
    report: Record<string, unknown>;
    conversations: number;
    analyzed_at: Date;
}

export async function saveAnalysis(
    pageDbId: number,
    report: unknown,
    conversations: number
): Promise<void> {
    await query(
        `INSERT INTO page_analysis (page_id, report, conversations, analyzed_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (page_id) DO UPDATE
            SET report = EXCLUDED.report,
                conversations = EXCLUDED.conversations,
                analyzed_at = now()`,
        [pageDbId, JSON.stringify(report), conversations]
    );
}

export function getAnalysis(pageDbId: number): Promise<StoredAnalysis | null> {
    return queryOne<StoredAnalysis>(
        `SELECT report, conversations, analyzed_at FROM page_analysis WHERE page_id = $1`,
        [pageDbId]
    );
}

/**
 * Tạo kịch bản rỗng gồm n tin để người dùng tự nhập trên dashboard.
 *
 * Nhãn lấy từ khung soạn chuẩn (3 cụm: giới thiệu → bằng chứng → thúc chốt),
 * nội dung để trống hẳn. Ràng buộc CHECK ở DB không cho tin rỗng, nên tạm điền
 * một dấu gạch — người dùng sẽ thay ngay ở màn hình nhập.
 */
export async function createEmptyScript(
    pageDbId: number,
    name: string,
    labels: string[]
): Promise<{ scriptId: number; count: number }> {
    const messages = labels.map((label) => ({ label, body: "—", media: [] as string[] }));
    const { script } = await replaceActiveScript(pageDbId, name, messages, {
        journeyDays: config.journey.days,
        slotsPerDay: config.journey.slotsPerDay,
    });
    return { scriptId: script.id, count: messages.length };
}
