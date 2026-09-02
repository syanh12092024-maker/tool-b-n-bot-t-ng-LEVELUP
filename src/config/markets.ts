/**
 * Múi giờ của từng thị trường TALPHA.
 *
 * Đây là bảng tra CỨNG, không đọc từ env: sai múi giờ nghĩa là bắn tin lúc
 * 3 giờ sáng cho khách hàng thật. Page nào thuộc thị trường lạ thì phải khai
 * utc_offset thủ công khi thêm page.
 */
export interface Market {
    readonly key: string;
    readonly label: string;
    readonly city: string;
    readonly utcOffset: number;
    readonly flag: string;
}

export const MARKETS = {
    Saudi:   { key: "Saudi",   label: "Ả Rập Xê Út", city: "Riyadh",     utcOffset: 3, flag: "🇸🇦" },
    UAE:     { key: "UAE",     label: "UAE",          city: "Dubai",      utcOffset: 4, flag: "🇦🇪" },
    Kuwait:  { key: "Kuwait",  label: "Kuwait",       city: "Kuwait City",utcOffset: 3, flag: "🇰🇼" },
    Oman:    { key: "Oman",    label: "Oman",         city: "Muscat",     utcOffset: 4, flag: "🇴🇲" },
    Qatar:   { key: "Qatar",   label: "Qatar",        city: "Doha",       utcOffset: 3, flag: "🇶🇦" },
    Bahrain: { key: "Bahrain", label: "Bahrain",      city: "Manama",     utcOffset: 3, flag: "🇧🇭" },
    Japan:   { key: "Japan",   label: "Nhật Bản",     city: "Tokyo",      utcOffset: 9, flag: "🇯🇵" },
    Taiwan:  { key: "Taiwan",  label: "Đài Loan",     city: "Đài Bắc",    utcOffset: 8, flag: "🇹🇼" },
} as const satisfies Record<string, Market>;

export type MarketKey = keyof typeof MARKETS;

export const MARKET_KEYS = Object.keys(MARKETS) as MarketKey[];

export function isMarketKey(v: string): v is MarketKey {
    return Object.prototype.hasOwnProperty.call(MARKETS, v);
}

/** Trả về múi giờ của thị trường, hoặc null nếu không nhận ra tên. */
export function utcOffsetOf(market: string): number | null {
    return isMarketKey(market) ? MARKETS[market].utcOffset : null;
}
