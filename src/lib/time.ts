/**
 * Xử lý múi giờ.
 *
 * Các thị trường TALPHA (vùng Vịnh, Nhật, Đài Loan) đều KHÔNG áp dụng giờ mùa hè,
 * nên dùng offset cố định là chính xác — không cần thư viện timezone.
 *
 * Cách làm: dịch mốc thời gian theo offset rồi đọc bằng getter UTC. Tuyệt đối
 * không dùng getTimezoneOffset() của máy chủ — bản v1 làm vậy và bị lệch ngày
 * khi server đặt ở múi giờ khác.
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** 'YYYY-MM-DD' theo giờ địa phương của page. */
export function localDateStr(utcOffset: number, at: Date = new Date()): string {
    const shifted = new Date(at.getTime() + utcOffset * HOUR_MS);
    return shifted.toISOString().slice(0, 10);
}

/** Giờ dạng thập phân theo giờ địa phương: 13.5 nghĩa là 13:30. */
export function localHourDecimal(utcOffset: number, at: Date = new Date()): number {
    const shifted = new Date(at.getTime() + utcOffset * HOUR_MS);
    return shifted.getUTCHours() + shifted.getUTCMinutes() / 60;
}

/** 'HH:MM' theo giờ địa phương — chỉ dùng để hiển thị. */
export function localTimeStr(utcOffset: number, at: Date = new Date()): string {
    const shifted = new Date(at.getTime() + utcOffset * HOUR_MS);
    const h = String(shifted.getUTCHours()).padStart(2, "0");
    const m = String(shifted.getUTCMinutes()).padStart(2, "0");
    return `${h}:${m}`;
}

/**
 * Đổi (ngày địa phương, giờ địa phương) thành mốc UTC thật.
 * Ví dụ: ('2026-08-31', 6, +3) → 2026-08-31T03:00:00Z
 */
export function localSlotToUtc(localDate: string, hour: number, utcOffset: number): Date {
    const parts = localDate.split("-");
    if (parts.length !== 3) {
        throw new Error(`Ngày không đúng định dạng YYYY-MM-DD: "${localDate}"`);
    }
    const y = Number(parts[0]);
    const m = Number(parts[1]);
    const d = Number(parts[2]);
    if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) {
        throw new Error(`Ngày không hợp lệ: "${localDate}"`);
    }
    const asIfUtc = Date.UTC(y, m - 1, d, Math.floor(hour), Math.round((hour % 1) * 60), 0, 0);
    return new Date(asIfUtc - utcOffset * HOUR_MS);
}

/**
 * Số ngày ĐỊA PHƯƠNG trôi qua giữa hai mốc.
 * So sánh theo ngày lịch, không theo số giờ — nên 23:59 sang 00:01 tính là 1 ngày.
 */
export function localDaysBetween(from: Date, to: Date, utcOffset: number): number {
    const a = Date.parse(`${localDateStr(utcOffset, from)}T00:00:00Z`);
    const b = Date.parse(`${localDateStr(utcOffset, to)}T00:00:00Z`);
    return Math.round((b - a) / DAY_MS);
}

/**
 * Ngày thứ mấy trong hành trình. Ngày khách được thêm vào tệp là ngày 1.
 * Trả về số ≥ 1; nếu first_seen ở tương lai (lệch giờ) thì kẹp về 1.
 */
export function journeyDayFor(firstSeenAt: Date, utcOffset: number, at: Date = new Date()): number {
    return Math.max(1, localDaysBetween(firstSeenAt, at, utcOffset) + 1);
}

/** Khách còn nằm trong cửa sổ Facebook cho phép chủ động nhắn không? */
export function isWithinSendWindow(lastInteractionAt: Date, windowDays: number, at: Date = new Date()): boolean {
    return at.getTime() - lastInteractionAt.getTime() < windowDays * DAY_MS;
}

/** Cộng phút vào một mốc thời gian. */
export function addMinutes(at: Date, minutes: number): Date {
    return new Date(at.getTime() + minutes * 60_000);
}

/** Cộng giờ vào một mốc thời gian. */
export function addHours(at: Date, hours: number): Date {
    return new Date(at.getTime() + hours * HOUR_MS);
}

/** Làm tròn xuống bội số phút gần nhất — dùng để chia cửa sổ thống kê. */
export function floorToMinutes(at: Date, minutes: number): Date {
    const ms = minutes * 60_000;
    return new Date(Math.floor(at.getTime() / ms) * ms);
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export { DAY_MS, HOUR_MS };
