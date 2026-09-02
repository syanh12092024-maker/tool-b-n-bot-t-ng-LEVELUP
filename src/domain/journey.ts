import { config } from "../config/index.js";

/**
 * Công thức xoay vòng nội dung.
 *
 *   msgIndex = ((journeyDay - 1) * slotsPerDay + slotIndex) mod messageCount
 *
 * Với cấu hình mặc định (7 ngày × 4 khung, 12 nội dung) ta được:
 *
 *   Ngày 1:  tin 0  1  2  3
 *   Ngày 2:  tin 4  5  6  7
 *   Ngày 3:  tin 8  9 10 11
 *   Ngày 4:  tin 0  1  2  3   ← vòng 2
 *   Ngày 5:  tin 4  5  6  7
 *   Ngày 6:  tin 8  9 10 11
 *   Ngày 7:  tin 0  1  2  3   ← vòng 3
 *
 * Hai tính chất có được miễn phí, và cả hai đều quan trọng với khách hàng thật:
 *   1. Trong CÙNG MỘT NGÀY khách không bao giờ nhận hai tin trùng nhau
 *      (vì 4 slot liên tiếp luôn cho 4 chỉ số khác nhau khi messageCount ≥ 4).
 *   2. Khoảng cách giữa hai lần lặp của cùng một tin luôn bằng nhau
 *      (messageCount / slotsPerDay = 3 ngày với cấu hình mặc định).
 */

export interface JourneySlot {
    /** 0-based, tương ứng vị trí trong config.journey.slotHours */
    slotIndex: number;
    /** Giờ địa phương của page: 6, 11, 17, 21 */
    hour: number;
    /** 0-based, tương ứng script_messages.order_index */
    messageIndex: number;
}

/** Chỉ số nội dung cho một (ngày, khung giờ) cụ thể. */
export function messageIndexFor(
    journeyDay: number,
    slotIndex: number,
    slotsPerDay: number = config.journey.slotsPerDay,
    messageCount: number = config.journey.messageCount
): number {
    if (journeyDay < 1) throw new Error(`journeyDay phải >= 1, nhận được ${journeyDay}`);
    if (slotIndex < 0 || slotIndex >= slotsPerDay) {
        throw new Error(`slotIndex phải nằm trong [0, ${slotsPerDay - 1}], nhận được ${slotIndex}`);
    }
    if (messageCount < 1) throw new Error(`messageCount phải >= 1, nhận được ${messageCount}`);

    const globalSlot = (journeyDay - 1) * slotsPerDay + slotIndex;
    return globalSlot % messageCount;
}

/** Toàn bộ các lượt gửi của một ngày trong hành trình. */
export function slotsForDay(
    journeyDay: number,
    opts: { slotHours?: readonly number[]; messageCount?: number } = {}
): JourneySlot[] {
    const slotHours = opts.slotHours ?? config.journey.slotHours;
    const messageCount = opts.messageCount ?? config.journey.messageCount;

    return slotHours.map((hour, slotIndex) => ({
        slotIndex,
        hour,
        messageIndex: messageIndexFor(journeyDay, slotIndex, slotHours.length, messageCount),
    }));
}

/** Khách còn trong hành trình không? Quá journeyDays là đã đi hết chuỗi. */
export function isWithinJourney(journeyDay: number, journeyDays: number = config.journey.days): boolean {
    return journeyDay >= 1 && journeyDay <= journeyDays;
}

/**
 * Bảng lịch đầy đủ của một hành trình — dùng để in ra cho người xem kiểm tra,
 * và để test khẳng định công thức không đổi khi ai đó sửa cấu hình.
 */
export function journeyTable(
    opts: { journeyDays?: number; slotHours?: readonly number[]; messageCount?: number } = {}
): Array<{ day: number; slots: JourneySlot[] }> {
    const journeyDays = opts.journeyDays ?? config.journey.days;
    const table: Array<{ day: number; slots: JourneySlot[] }> = [];
    for (let day = 1; day <= journeyDays; day++) {
        table.push({ day, slots: slotsForDay(day, opts) });
    }
    return table;
}
