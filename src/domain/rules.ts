/**
 * Luật nghiệp vụ dùng chung — MỘT nơi duy nhất.
 *
 * Bản v1 có hai bản sao của danh sách tag mua hàng (một ở UI, một ở cron) và
 * chúng lệch nhau theo thời gian. Ở đây mọi job import từ đúng file này.
 */

/** Tag trên hội thoại Pancake cho biết khách đã mua / đã chốt. */
export const PURCHASE_TAGS: readonly string[] = [
    "đã gửi", "da gui", "đã gửi hàng",
    "đã nhận", "da nhan",
    "mua hàng", "mua hang", "đã mua", "da mua",
    "đã chốt", "da chot", "chốt đơn", "chot don",
    "shipped", "delivered", "ordered", "purchased",
];

export function hasPurchaseTag(tags: readonly string[]): string | null {
    for (const raw of tags) {
        const t = raw.toLowerCase();
        for (const pt of PURCHASE_TAGS) {
            if (t.includes(pt)) return raw;
        }
    }
    return null;
}

/**
 * Từ khoá khách nhắn để từ chối nhận tin. So khớp theo TỪ (word boundary) để
 * "stop" không bắt nhầm "stopwatch"; tiếng Việt/Ả Rập/Nhật so khớp chuỗi con.
 */
const OPT_OUT_WORDS: readonly RegExp[] = [
    /\bstop\b/i,
    /\bunsubscribe\b/i,
    /\bcancel\b/i,
    /\bno more\b/i,
    /\bdon'?t (message|text|send)\b/i,
    /\bleave me alone\b/i,
    /\bremove me\b/i,
];

const OPT_OUT_SUBSTRINGS: readonly string[] = [
    // Tiếng Việt
    "đừng nhắn", "dung nhan", "đừng gửi", "dung gui", "không cần nữa", "khong can nua",
    "huỷ", "hủy", "huy dang ky", "bỏ theo dõi",
    // Ả Rập — phổ biến ở vùng Vịnh
    "توقف", "لا ترسل", "إلغاء", "لا اريد", "لا أريد",
    // Nhật
    "やめて", "送らないで", "配信停止", "解除",
    // Trung (Đài Loan)
    "不要再傳", "不要再发", "取消訂閱", "取消订阅", "停止",
];

/** Trả về từ khoá khớp được, hoặc null nếu tin không phải lời từ chối. */
export function matchOptOut(text: string): string | null {
    const t = text.trim();
    if (!t) return null;
    // Tin quá dài thường là hội thoại bình thường có chứa từ "stop" — không tính
    if (t.length > 120) return null;

    for (const re of OPT_OUT_WORDS) {
        const m = re.exec(t);
        if (m) return m[0];
    }
    const lower = t.toLowerCase();
    for (const s of OPT_OUT_SUBSTRINGS) {
        if (lower.includes(s.toLowerCase())) return s;
    }
    return null;
}
