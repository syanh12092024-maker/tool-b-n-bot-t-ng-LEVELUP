import type { ChatMessage } from "../clients/pancake.js";

/**
 * Bóc tách hội thoại thật thành số liệu để NGƯỜI soạn nội dung bot.
 *
 * Không dùng AI. Toàn bộ là đếm, khớp mẫu và xếp hạng — chạy miễn phí, kết quả
 * kiểm chứng được (mỗi con số truy ngược ra được hội thoại gốc).
 *
 * Chủ đích: trả lời đúng những câu người viết nội dung cần biết —
 * khách hỏi gì nhiều nhất, nhân viên trả lời ra sao, giá bao nhiêu,
 * và câu nào nói ra thì khách để lại số điện thoại.
 */

// ─── Ngôn ngữ ─────────────────────────────────────────────────────────────────

export type Lang = "ar" | "ja" | "zh" | "ko" | "th" | "vi" | "latin" | "unknown";

const SCRIPTS: Array<{ lang: Lang; re: RegExp }> = [
    { lang: "ar", re: /[؀-ۿݐ-ݿ]/ },
    { lang: "ja", re: /[぀-ゟ゠-ヿ]/ },  // hiragana/katakana — kiểm trước zh
    { lang: "ko", re: /[가-힯ᄀ-ᇿ]/ },
    { lang: "th", re: /[฀-๿]/ },
    { lang: "zh", re: /[一-鿿]/ },
    { lang: "vi", re: /[ăâđêôơưĂÂĐÊÔƠƯ]|[àáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i },
];

/**
 * Nhận ngôn ngữ theo BẢNG CHỮ CÁI, không đoán theo từ vựng.
 * Chắc chắn vì mỗi hệ chữ có dải ký tự Unicode riêng — không có chuyện nhầm lẫn.
 */
export function detectLang(text: string): Lang {
    if (!text.trim()) return "unknown";
    for (const s of SCRIPTS) if (s.re.test(text)) return s.lang;
    return /[a-z]/i.test(text) ? "latin" : "unknown";
}

// ─── Giá ──────────────────────────────────────────────────────────────────────

const CURRENCIES = ["SAR", "AED", "KWD", "OMR", "QAR", "BHD", "JPY", "TWD", "USD", "ريال", "درهم", "دينار"];
const PRICE_RE = new RegExp(
    `(?:(${CURRENCIES.join("|")})\\s*([0-9][0-9.,]*)|([0-9][0-9.,]*)\\s*(${CURRENCIES.join("|")}))`,
    "gi"
);

export interface PriceHit { amount: number; currency: string; }

/** Rút mọi con số kèm đơn vị tiền trong một đoạn chữ. */
export function extractPrices(text: string): PriceHit[] {
    const out: PriceHit[] = [];
    for (const m of text.matchAll(PRICE_RE)) {
        const cur = (m[1] ?? m[4] ?? "").toUpperCase();
        const numRaw = (m[2] ?? m[3] ?? "").replace(/,/g, "");
        const amount = Number(numRaw);
        // Loại số vô lý: 0 hoặc quá lớn thường là mã đơn, số điện thoại
        if (cur && Number.isFinite(amount) && amount > 0 && amount < 1_000_000) {
            out.push({ amount, currency: cur });
        }
    }
    return out;
}

// ─── Số điện thoại ────────────────────────────────────────────────────────────

/** Khách để lại số điện thoại trong tin này? Cần ≥8 chữ số liên tiếp. */
export function looksLikePhone(text: string): boolean {
    const digits = text.replace(/[^\d]/g, "");
    if (digits.length < 8 || digits.length > 15) return false;
    return /[\d][\d\s.\-()+]{7,}[\d]/.test(text);
}

// ─── Chuẩn hoá & gom nhóm ─────────────────────────────────────────────────────

/** Đưa câu về dạng so sánh được: bỏ dấu câu, emoji, số, gộp khoảng trắng. */
export function normalize(text: string): string {
    return text
        .toLowerCase()
        .replace(/[\p{Extended_Pictographic}‍️]/gu, " ")
        .replace(/[0-9]+/g, " ")
        .replace(/[^\p{L}\s]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
}

const STOP = new Set([
    "the","a","an","is","are","am","i","you","it","to","of","and","or","in","on","for","do","does",
    "can","could","would","will","my","me","your","this","that","have","has","be","was","were","with",
    "how","what","when","where","which","if","so","but","at","from","by","as","not","no","yes","ok",
    "please","hi","hello","thanks","thank","good","morning","evening",
    "هل","في","من","على","الى","إلى","ما","هذا","هذه","انا","أنا","هو","هي","و","او","أو","لا","نعم",
]);

/** Cụm từ hay gặp nhất trong một tập câu (1–3 từ), đã bỏ từ vô nghĩa. */
export function topPhrases(texts: string[], opts: { maxWords?: number; limit?: number; minCount?: number } = {}) {
    const maxWords = opts.maxWords ?? 3;
    const limit = opts.limit ?? 15;
    const minCount = opts.minCount ?? 2;

    const counts = new Map<string, number>();
    for (const t of texts) {
        const words = normalize(t).split(" ").filter((w) => w.length > 1 && !STOP.has(w));
        const seen = new Set<string>();
        for (let n = 1; n <= maxWords; n++) {
            for (let i = 0; i + n <= words.length; i++) {
                const phrase = words.slice(i, i + n).join(" ");
                if (phrase.length < 3) continue;
                if (seen.has(phrase)) continue; // đếm 1 lần cho mỗi tin
                seen.add(phrase);
                counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
            }
        }
    }

    return [...counts.entries()]
        .filter(([, c]) => c >= minCount)
        // Ưu tiên cụm dài hơn khi số lần bằng nhau: "how much" thông tin hơn "much"
        .sort((a, b) => b[1] - a[1] || b[0].split(" ").length - a[0].split(" ").length)
        .slice(0, limit)
        .map(([phrase, count]) => ({ phrase, count }));
}

/** Câu lặp lại nhiều nhất, giữ nguyên văn bản gốc để đọc được. */
export function topRepeatedMessages(texts: string[], limit = 10, minCount = 2) {
    const byNorm = new Map<string, { count: number; sample: string }>();
    for (const t of texts) {
        const key = normalize(t);
        if (key.length < 8) continue;
        const cur = byNorm.get(key);
        if (cur) cur.count++;
        else byNorm.set(key, { count: 1, sample: t.trim() });
    }
    return [...byNorm.values()]
        .filter((v) => v.count >= minCount)
        .sort((a, b) => b.count - a.count)
        .slice(0, limit);
}

// ─── Phân tích một hội thoại ──────────────────────────────────────────────────

export interface ConversationFacts {
    customerMessages: string[];
    pageMessages: string[];
    firstCustomerMessage: string | null;
    /** Tin của page ngay TRƯỚC khi khách để lại số điện thoại */
    lineBeforePhone: string | null;
    gavePhone: boolean;
    /** Khách hỏi giá ở tin thứ mấy của họ (1-based), 0 = không hỏi */
    priceAskedAtTurn: number;
    prices: PriceHit[];
    lang: Lang;
    adText: string | null;
    exchanges: number;
}

const PRICE_ASK = /\b(how much|price|cost|magkano|kam|بكم|السعر|كم سعر|كم السعر|الثمن)\b/i;

export function analyzeConversation(messages: ChatMessage[]): ConversationFacts {
    const customerMessages: string[] = [];
    const pageMessages: string[] = [];
    let lineBeforePhone: string | null = null;
    let gavePhone = false;
    let priceAskedAtTurn = 0;
    let adText: string | null = null;
    let lastPageLine: string | null = null;

    for (const m of messages) {
        if (m.adText && !adText) adText = m.adText;
        if (!m.text) continue;

        if (m.fromPage) {
            pageMessages.push(m.text);
            lastPageLine = m.text;
        } else {
            customerMessages.push(m.text);
            if (!gavePhone && looksLikePhone(m.text)) {
                gavePhone = true;
                lineBeforePhone = lastPageLine; // câu đã dẫn tới việc khách đưa số
            }
            if (!priceAskedAtTurn && PRICE_ASK.test(m.text)) {
                priceAskedAtTurn = customerMessages.length;
            }
        }
    }

    const prices = pageMessages.flatMap(extractPrices);
    const langSample = customerMessages.join(" ").slice(0, 500);

    return {
        customerMessages,
        pageMessages,
        firstCustomerMessage: customerMessages[0] ?? null,
        lineBeforePhone,
        gavePhone,
        priceAskedAtTurn,
        prices,
        lang: detectLang(langSample),
        adText,
        exchanges: customerMessages.length + pageMessages.length,
    };
}

// ─── Vấn đề / phản đối của khách ──────────────────────────────────────────────

/**
 * Các nhóm băn khoăn khiến khách KHÔNG chốt.
 *
 * Đây là phần quan trọng nhất với người viết nội dung: mỗi nhóm ở đây xứng đáng
 * một tin trong kịch bản. Từ khoá cả tiếng Anh lẫn tiếng Ả Rập vì khách dùng cả hai.
 *
 * Cố ý dùng danh sách từ khoá thay vì AI: kết quả ổn định, giải thích được, và
 * anh/chị thêm bớt từ khoá được mà không cần sửa code.
 */
/**
 * Ranh giới từ cho tiếng Ả Rập.
 *
 * \b của JavaScript chỉ hiểu chữ Latin, nên `محل` (cửa hàng) khớp vào GIỮA chữ
 * `محلول` (dung dịch) và xếp nhầm câu "có cần dung dịch không?" thành "muốn tới
 * cửa hàng". Dùng lookaround chặn hai đầu bằng chính dải chữ Ả Rập.
 */
function ar(...words: string[]): string {
    const A = "\\u0600-\\u06FF\\u0750-\\u077F";
    // Tiếng Ả Rập dính tiền tố vào từ: المحل = ال (mạo từ) + محل (cửa hàng),
    // للمحل = لل + محل. Chặn cứng cả hai đầu sẽ bỏ sót hết những dạng đó.
    // Cho phép cụm tiền tố و ف ب ك ل và mạo từ ال ở ĐẦU, nhưng vẫn chặn ở CUỐI —
    // đó mới là chỗ ngăn محل khớp nhầm vào giữa محلول (dung dịch).
    return words.map((w) => `(?<![${A}])[\u0648\u0641\u0628\u0643\u0644]*(?:\u0627\u0644)?${w}(?![${A}])`).join("|");
}

/**
 * Các nhóm băn khoăn khiến khách KHÔNG chốt.
 *
 * Đây là phần quan trọng nhất với người viết nội dung: mỗi nhóm ở đây xứng đáng
 * một tin trong kịch bản. Từ khoá cả tiếng Anh lẫn tiếng Ả Rập vì khách dùng cả hai.
 *
 * Cố ý dùng danh sách từ khoá thay vì AI: kết quả ổn định, giải thích được, và
 * anh/chị thêm bớt từ khoá được mà không cần sửa code.
 */
export const OBJECTION_GROUPS: Array<{ key: string; label: string; re: RegExp }> = [
    { key: "scam",     label: "Nghi lừa đảo / không tin tưởng",
      re: new RegExp(`\\b(scam|fake|fraud|cheat|liar|not real|don'?t trust)\\b|${ar("نصب","احتيال","كذب","نصاب","نصابين","مزور")}`, "i") },
    { key: "price",    label: "Chê đắt / xin giảm giá",
      re: new RegExp(`\\b(expensive|too much|cheaper|discount|lower price)\\b|${ar("غالي","غالية","تخفيض","خصم","أرخص","ارخص")}`, "i") },
    { key: "quality",  label: "Nghi ngờ chất lượng / hàng hỏng",
      re: new RegExp(`\\b(broken|useless|bad quality|doesn'?t fit|not fit|damaged|cheap quality)\\b|${ar("بلاستيك","رديء","سيء","مكسور","خربان")}`, "i") },
    { key: "fit",      label: "Hỏi có vừa / dùng được cho mình không",
      re: new RegExp(`\\b(does it work|really work|will it fit|suitable for me|my size|without measur)\\b|${ar("ينفع","يصلح","مناسب","المقاس","يركب","بدون أسنان")}`, "i") },
    { key: "delivery", label: "Hỏi giao hàng / thời gian",
      re: new RegExp(`\\b(delivery|shipping|how long|courier|track)\\b|${ar("توصيل","التوصيل","شحن","متى يصل")}`, "i") },
    { key: "refund",   label: "Hỏi đổi trả / bảo hành",
      re: new RegExp(`\\b(refund|return|money.?back|guarantee|warranty|exchange)\\b|${ar("استرجاع","ضمان","استبدال","ارجاع","إرجاع")}`, "i") },
    { key: "store",    label: "Muốn tới tận nơi / hỏi cửa hàng",
      re: new RegExp(`\\b(branch|showroom|pick.?up|come to your|visit your)\\b|${ar("فرع","محل","معرض","أستلم","استلم")}`, "i") },
    { key: "payment",  label: "Hỏi cách thanh toán / COD",
      re: new RegExp(`\\b(cash on delivery|cod|payment|transfer|installment)\\b|${ar("الدفع","كاش","تحويل","تقسيط")}`, "i") },
    { key: "medical",  label: "Lo ngại y tế / tình trạng răng lợi",
      re: new RegExp(`\\b(dentist|gum|pain|hurt|allerg|sensitive|infection|surgery)\\b|${ar("طبيب","لثة","ألم","يوجع","حساسية","التهاب")}`, "i") },
];

export interface ObjectionHit {
    key: string;
    label: string;
    count: number;
    pct: number;
    samples: string[];
}

/** Đếm xem mỗi nhóm băn khoăn xuất hiện ở bao nhiêu HỘI THOẠI (không phải bao nhiêu tin). */
export function findObjections(convs: ConversationFacts[]): ObjectionHit[] {
    const withMsg = convs.filter((c) => c.customerMessages.length > 0);
    const out: ObjectionHit[] = [];

    for (const g of OBJECTION_GROUPS) {
        const samples: string[] = [];
        let count = 0;
        for (const c of withMsg) {
            const hit = c.customerMessages.find((m) => g.re.test(m));
            if (hit) {
                count++;
                if (samples.length < 3) samples.push(hit.replace(/\s+/g, " ").trim().slice(0, 160));
            }
        }
        if (count > 0) {
            out.push({ key: g.key, label: g.label, count, pct: count / Math.max(1, withMsg.length), samples });
        }
    }
    return out.sort((a, b) => b.count - a.count);
}

// ─── Tổng hợp nhiều hội thoại ─────────────────────────────────────────────────

export interface ChatReport {
    conversations: number;
    withCustomerMessage: number;
    gavePhone: number;
    phoneRate: number;
    avgExchanges: number;
    langs: Array<{ lang: Lang; count: number; pct: number }>;
    openingQuestions: Array<{ phrase: string; count: number }>;
    allCustomerPhrases: Array<{ phrase: string; count: number }>;
    priceAskedFirstTurn: number;
    prices: Array<{ currency: string; amount: number; count: number }>;
    staffReplies: Array<{ count: number; sample: string }>;
    linesBeforePhone: Array<{ count: number; sample: string }>;
    adTexts: Array<{ count: number; sample: string }>;
    objections: ObjectionHit[];
    longestCustomerMessages: string[];
}

export function buildReport(convs: ConversationFacts[]): ChatReport {
    const withMsg = convs.filter((c) => c.customerMessages.length > 0);
    const gave = withMsg.filter((c) => c.gavePhone);

    const langCount = new Map<Lang, number>();
    for (const c of withMsg) langCount.set(c.lang, (langCount.get(c.lang) ?? 0) + 1);

    const priceCount = new Map<string, number>();
    for (const c of convs) {
        for (const p of c.prices) {
            const k = `${p.currency} ${p.amount}`;
            priceCount.set(k, (priceCount.get(k) ?? 0) + 1);
        }
    }

    const firstMsgs = withMsg.map((c) => c.firstCustomerMessage!).filter(Boolean);
    const allCustomer = withMsg.flatMap((c) => c.customerMessages);

    return {
        conversations: convs.length,
        withCustomerMessage: withMsg.length,
        gavePhone: gave.length,
        phoneRate: withMsg.length ? gave.length / withMsg.length : 0,
        avgExchanges: withMsg.length
            ? Math.round((withMsg.reduce((a, c) => a + c.exchanges, 0) / withMsg.length) * 10) / 10
            : 0,
        langs: [...langCount.entries()]
            .map(([lang, count]) => ({ lang, count, pct: count / Math.max(1, withMsg.length) }))
            .sort((a, b) => b.count - a.count),
        openingQuestions: topPhrases(firstMsgs, { limit: 15, minCount: 2 }),
        allCustomerPhrases: topPhrases(allCustomer, { limit: 20, minCount: 3 }),
        priceAskedFirstTurn: withMsg.filter((c) => c.priceAskedAtTurn === 1).length,
        prices: [...priceCount.entries()]
            .map(([k, count]) => {
                const [currency = "", amt = "0"] = k.split(" ");
                return { currency, amount: Number(amt), count };
            })
            .sort((a, b) => b.count - a.count)
            .slice(0, 10),
        staffReplies: topRepeatedMessages(convs.flatMap((c) => c.pageMessages), 12, 2),
        linesBeforePhone: topRepeatedMessages(
            gave.map((c) => c.lineBeforePhone).filter((s): s is string => Boolean(s)), 8, 1),
        adTexts: topRepeatedMessages(convs.map((c) => c.adText).filter((s): s is string => Boolean(s)), 5, 1),
        objections: findObjections(convs),
        longestCustomerMessages: allCustomer
            .filter((t) => t.length > 40)
            .sort((a, b) => b.length - a.length)
            .slice(0, 5),
    };
}
