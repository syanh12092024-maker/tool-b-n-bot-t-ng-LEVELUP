import { NextRequest, NextResponse } from "next/server";
import {
    loadSchedules,
    saveSchedule,
    type BroadcastSchedule,
    type ScheduleSegment,
} from "@/lib/firestore/schedule.model";
import { requireCronAuth } from "@/lib/auth";

// ═══ LOCK trong process: chặn 2 lượt cron chạy chồng nhau bắn cùng 1 segment ═══
// (bổ sung cho guard sentAt/startedAt bên dưới — guard đó chỉ hiệu quả giữa các tick)
const firingLocks = new Set<string>();

// Headers cho self-call nội bộ (khi bật APP_ACCESS_KEY thì /api/broadcast yêu cầu key)
function internalHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const key = (process.env.APP_ACCESS_KEY || "").trim();
    return key ? { ...extra, "x-app-key": key } : extra;
}

// ─── Timezone mapping (same as broadcast-tab) ─────────────────────────────────
const SHOP_TIMEZONES: Record<string, number> = {
    Saudi: 3,
    UAE: 4,
    Kuwait: 3,
    Oman: 4,
    Qatar: 3,
    Bahrain: 3,
    Japan: 9,
    Taiwan: 8,
};

// Cả 2 hàm dưới: dịch epoch theo offset rồi đọc bằng getter UTC —
// kết quả KHÔNG phụ thuộc múi giờ của server (trước đây getTodayDateStr
// cộng thêm getTimezoneOffset() rồi đọc toISOString → lệch ngày trên máy UTC+7)
function getTodayDateStr(utcOffset: number): string {
    const target = new Date(Date.now() + utcOffset * 3600000);
    return target.toISOString().slice(0, 10);
}

function getCurrentDecimal(utcOffset: number): number {
    const target = new Date(Date.now() + utcOffset * 3600000);
    return target.getUTCHours() + target.getUTCMinutes() / 60;
}

// Purchase tag list for filtering
const PURCHASE_TAGS = [
    "đã gửi", "đã nhận", "da gui", "da nhan", "mua hàng", "mua hang",
    "đã mua", "da mua", "shipped", "delivered", "đã gửi hàng", "đã chốt",
    "da chot", "chốt đơn", "chot don",
];

interface Customer {
    id: string;
    customerName: string;
    customerPhone: string;
    psid: string;
    pageFbId: string;
    orderCount: number;
    tags: (string | number)[];
    updatedAt?: string;
    lastInteraction?: string;
}

// ─── CRON HANDLER ─────────────────────────────────────────────────────────────
// Vercel Cron calls this every 15 minutes
// Also supports manual trigger via GET ?secret=xxx
export async function GET(req: NextRequest) {
    const startTime = Date.now();
    const logs: string[] = [];
    const log = (msg: string) => {
        console.log(`[cron] ${msg}`);
        logs.push(msg);
    };

    try {
        // ── Security: chấp nhận CRON_SECRET (Bearer/?secret=) hoặc x-app-key
        // (để nút "Bắn ngay" trên UI vẫn hoạt động khi bật auth) ──
        const authError = requireCronAuth(req);
        if (authError) return authError;

        log("⏰ Cron job started");

        const schedules = await loadSchedules();
        log(`📋 Loaded ${schedules.length} schedules from BigQuery`);

        if (schedules.length === 0) {
            return NextResponse.json({ ok: true, message: "No schedules", logs });
        }

        // ─── BẮN NGAY 1 ĐOẠN (manual fire, bỏ qua kiểm tra giờ) ───────────────
        // GET /api/broadcast/cron?fire=<scheduleId>&seg=<segIdx>
        const fireId = new URL(req.url).searchParams.get("fire");
        if (fireId) {
            const segParam = new URL(req.url).searchParams.get("seg");
            const schedule = schedules.find((s) => s.id === fireId);
            if (!schedule) {
                return NextResponse.json({ ok: false, error: "Không tìm thấy lịch" }, { status: 404 });
            }

            const tz = SHOP_TIMEZONES[schedule.shopName] ?? 3;
            const todayStr = getTodayDateStr(tz);

            // Backward-compat: tạo segments từ messages nếu lịch cũ chưa có segments
            const allSegs: ScheduleSegment[] = schedule.segments?.length
                ? schedule.segments
                : (schedule.messages || [])
                      .map((m, i) => ({ segIdx: i, hour: schedule.hour, message: m }))
                      .filter((seg) => (seg.message || "").trim());
            schedule.segments = allSegs;

            // Chọn đoạn: theo segIdx nếu có, ngược lại lấy đoạn đầu có nội dung
            const target =
                segParam !== null
                    ? allSegs.find((seg) => seg.segIdx === Number(segParam))
                    : allSegs.find((seg) => (seg.message || "").trim() || (seg.media && seg.media.length));
            if (!target) {
                return NextResponse.json({ ok: false, error: "Đoạn không tồn tại hoặc rỗng" }, { status: 400 });
            }
            if (!(target.message || "").trim() && !(target.media && target.media.length)) {
                return NextResponse.json({ ok: false, error: "Đoạn này không có nội dung" }, { status: 400 });
            }

            log(`🚀 MANUAL FIRE Seg ${target.segIdx} (${target.hour}h) của lịch ${schedule.id}`);
            const manualLockKey = `${schedule.id}_${target.segIdx}`;
            if (firingLocks.has(manualLockKey)) {
                return NextResponse.json({ ok: false, error: "Đoạn này đang được gửi — chờ xong rồi thử lại" }, { status: 409 });
            }
            firingLocks.add(manualLockKey);
            try {
                // Sang ngày mới → reset các seg khác TRƯỚC khi ghi lastRunDate=hôm nay,
                // nếu không chúng kẹt status "sent" của hôm trước và auto-fire bỏ qua cả ngày
                if (!schedule.lastRunDate || schedule.lastRunDate !== todayStr) {
                    for (const seg of allSegs) {
                        seg.status = "pending";
                        seg.error = undefined;
                        seg.sentAt = undefined;
                    }
                }
                target.status = "sending";
                // Ghi mốc BẮT ĐẦU gửi vào sentAt để guard "stuck >30 phút" đo đúng
                // (trước đây sentAt chỉ set khi gửi XONG → segment đang gửi bị coi là kẹt 999' và bắn lại)
                target.sentAt = new Date().toISOString();
                schedule.lastRunDate = todayStr;
                await saveSchedule(schedule);

                const fired = await fireSegment(schedule, target, todayStr, log, req.signal);
                await persistScheduleAfterFire(schedule, target, log);
                return NextResponse.json({ ok: true, fired: 1, manual: true, result: fired, logs });
            } catch (err) {
                target.status = "error";
                target.error = err instanceof Error ? err.message : String(err);
                await persistScheduleAfterFire(schedule, target, log);
                return NextResponse.json({ ok: false, error: target.error, logs }, { status: 500 });
            } finally {
                // finally đảm bảo lock không leak kể cả khi saveSchedule throw
                firingLocks.delete(manualLockKey);
            }
        }

        let totalFired = 0;
        const results: Array<{
            scheduleId: string;
            segIdx: number;
            hour: number;
            recipients: number;
            success: number;
            errors: number;
        }> = [];

        for (const schedule of schedules) {
            if (!schedule.isActive) {
                log(`⏸️ Skip ${schedule.id} (inactive)`);
                continue;
            }
            if (!schedule.segments?.length) {
                log(`⏭️ Skip ${schedule.id} (no segments)`);
                continue;
            }

            const tz = SHOP_TIMEZONES[schedule.shopName] ?? 3;
            const todayStr = getTodayDateStr(tz);
            const currentDecimal = getCurrentDecimal(tz);

            log(`🏪 ${schedule.shopName} | Page: ${schedule.pageName} | TZ: UTC+${tz} | Now: ${currentDecimal.toFixed(2)}h | Today: ${todayStr}`);

            // Sang ngày mới → reset TẤT CẢ segments MỘT LƯỢT trước khi xử lý.
            // (Trước đây reset từng seg bên trong vòng lặp, nhưng vòng lặp `break`
            // ngay sau khi bắn seg đầu tiên → các seg đứng sau không bao giờ được
            // reset, từ ngày thứ 2 chúng kẹt status "sent" của hôm trước → không bắn)
            if (!schedule.lastRunDate || schedule.lastRunDate !== todayStr) {
                for (const seg of schedule.segments) {
                    seg.status = "pending";
                    seg.error = undefined;
                    seg.sentAt = undefined;
                }
            }

            for (const seg of schedule.segments) {
                // Skip already sent today
                if (seg.status === "sent" && schedule.lastRunDate === todayStr) {
                    log(`  ✅ Seg ${seg.segIdx} (${seg.hour}h) already sent today`);
                    continue;
                }
                // Skip currently sending — BUT reset if stuck > 30 minutes
                if (seg.status === "sending") {
                    const sentTime = seg.sentAt ? new Date(seg.sentAt).getTime() : 0;
                    const stuckMinutes = sentTime ? (Date.now() - sentTime) / 60000 : 999;
                    if (stuckMinutes < 30) {
                        log(`  ⏳ Seg ${seg.segIdx} (${seg.hour}h) currently sending (${stuckMinutes.toFixed(0)}m), skip`);
                        continue;
                    }
                    log(`  🔄 Seg ${seg.segIdx} (${seg.hour}h) was stuck in 'sending' for ${stuckMinutes.toFixed(0)}m — resetting`);
                    seg.status = "pending";
                }

                // Check if it's time to fire
                // Chỉ bắn nếu đúng giờ (trong khoảng 60 phút sau giờ hẹn)
                // VD: seg 6h → bắn từ 6:00–7:00, sau 7:00 → skip (đã qua quá lâu)
                const hoursPast = currentDecimal - seg.hour;
                if (currentDecimal >= seg.hour && seg.status !== "sent") {
                    if (hoursPast > 1.0) {
                        // Đã qua quá 60 phút → skip, đánh dấu skipped
                        log(`  ⏭️ Seg ${seg.segIdx} (${seg.hour}h) SKIPPED — đã qua ${(hoursPast * 60).toFixed(0)} phút (quá 60 phút)`);
                        seg.status = "sent"; // đánh dấu để không bắn lại
                        seg.error = `Bỏ qua — quá giờ ${(hoursPast * 60).toFixed(0)} phút`;
                        schedule.lastRunDate = todayStr;
                        await saveSchedule(schedule);
                        continue;
                    }

                    const lockKey = `${schedule.id}_${seg.segIdx}`;
                    if (firingLocks.has(lockKey)) {
                        log(`  🔒 Seg ${seg.segIdx} (${seg.hour}h) đang gửi ở lượt cron khác — skip`);
                        continue;
                    }

                    log(`  🔥 FIRING Seg ${seg.segIdx} (${seg.hour}h) — current time ${currentDecimal.toFixed(2)}h`);

                    firingLocks.add(lockKey);
                    try {
                        seg.status = "sending";
                        // Ghi mốc BẮT ĐẦU gửi để guard "stuck >30 phút" đo đúng (fix double-fire)
                        seg.sentAt = new Date().toISOString();
                        schedule.lastRunDate = todayStr;
                        await saveSchedule(schedule);

                        const fired = await fireSegment(schedule, seg, todayStr, log);
                        results.push(fired);
                        totalFired++;
                    } catch (err) {
                        seg.status = "error";
                        seg.error = err instanceof Error ? err.message : String(err);
                        log(`  ❌ Seg ${seg.segIdx} error: ${seg.error}`);
                    } finally {
                        // finally đảm bảo lock không leak kể cả khi saveSchedule throw
                        firingLocks.delete(lockKey);
                    }

                    // Ghi KẾT QUẢ trên bản schedule MỚI NHẤT — không ghi đè thao tác
                    // user vừa làm trên UI (Dừng, sửa note...) trong lúc đang gửi
                    await persistScheduleAfterFire(schedule, seg, log);

                    // Only fire 1 segment per schedule per cron run to avoid timeout
                    break;
                } else {
                    log(`  ⏰ Seg ${seg.segIdx} (${seg.hour}h) not yet — current ${currentDecimal.toFixed(2)}h`);
                }
            }
        }

        const elapsed = Date.now() - startTime;
        log(`✅ Cron complete: ${totalFired} segments fired in ${elapsed}ms`);

        return NextResponse.json({
            ok: true,
            fired: totalFired,
            results,
            elapsed,
            logs,
        });
    } catch (err) {
        console.error("[cron] Fatal error:", err);
        return NextResponse.json(
            {
                error: err instanceof Error ? err.message : "Unknown error",
                logs,
            },
            { status: 500 }
        );
    }
}

// ─── Ghi kết quả gửi mà KHÔNG ghi đè thao tác UI đồng thời ────────────────────
// fireSegment chạy nhiều phút; trong lúc đó user có thể bấm "Dừng" / sửa note
// trên UI. Nếu save nguyên object snapshot cũ thì các thay đổi đó bị revert
// (vd: campaign vừa tắt tự bật lại). Vì vậy: load bản MỚI NHẤT, chỉ chép phần
// kết quả gửi của đúng segment vừa bắn vào rồi save.
async function persistScheduleAfterFire(
    local: BroadcastSchedule,
    seg: ScheduleSegment,
    log: (msg: string) => void
): Promise<void> {
    try {
        const all = await loadSchedules();
        const fresh = all.find((s) => s.id === local.id);
        if (!fresh) {
            log(`  ⚠️ Lịch ${local.id} đã bị xoá trong lúc gửi — bỏ qua ghi kết quả`);
            return;
        }
        fresh.lastFiredAt = local.lastFiredAt;
        fresh.lastRunDate = local.lastRunDate;
        fresh.firedDates = local.firedDates;
        if (!fresh.segments?.length) fresh.segments = local.segments; // lịch cũ chưa có segments
        const freshSeg = (fresh.segments || []).find((x) => x.segIdx === seg.segIdx);
        if (freshSeg && freshSeg !== seg) {
            freshSeg.status = seg.status;
            freshSeg.error = seg.error;
            freshSeg.sentAt = seg.sentAt;
            freshSeg.totalRecipients = seg.totalRecipients;
            freshSeg.successCount = seg.successCount;
            freshSeg.errorCount = seg.errorCount;
        }
        await saveSchedule(fresh);
    } catch (e) {
        log(`  ⚠️ Ghi kết quả sau khi bắn lỗi: ${e instanceof Error ? e.message : String(e)}`);
    }
}

// ─── Fire a single segment ────────────────────────────────────────────────────
async function fireSegment(
    schedule: BroadcastSchedule,
    seg: ScheduleSegment,
    todayStr: string,
    log: (msg: string) => void,
    signal?: AbortSignal
): Promise<{ scheduleId: string; segIdx: number; hour: number; recipients: number; success: number; errors: number; aborted?: boolean }> {
    // 1. Fetch customers for this shop+page
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL
        || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
        || "http://localhost:3001";

    // Chỉ kèm shopId khi có giá trị POS thật; nếu rỗng → dùng đường CRM (pageFilter)
    const shopParam = schedule.shopId ? `shopId=${encodeURIComponent(schedule.shopId)}&` : "";
    const custUrl = `${baseUrl}/api/broadcast?${shopParam}pageFilter=${schedule.pageId}`;
    log(`  📡 Fetching customers: ${custUrl.replace(/api_key=[^&]+/, "api_key=***")}`);

    const custRes = await fetch(custUrl, { headers: internalHeaders(), signal: AbortSignal.timeout(240000) });
    const custData = await custRes.json();
    let allCust: Customer[] = custData.customers || [];
    log(`  👥 Got ${allCust.length} customers (raw)`);

    // 2. Apply purchase filter
    if (schedule.filterPurchase === "no_purchase") {
        allCust = allCust.filter((c) => {
            if (c.customerPhone || c.orderCount > 0) return false;
            const tagStr = (c.tags || []).map((t) => String(t).toLowerCase()).join(" ");
            if (PURCHASE_TAGS.some((pt) => tagStr.includes(pt))) return false;
            return true;
        });
        log(`  🔍 After no_purchase filter: ${allCust.length}`);
    } else if (schedule.filterPurchase === "has_purchase") {
        allCust = allCust.filter((c) => c.customerPhone || c.orderCount > 0);
        log(`  🔍 After has_purchase filter: ${allCust.length}`);
    }

    // 2b. Filter theo cửa sổ gửi được: chỉ giữ khách tương tác trong 1–7 ngày.
    // - >7 ngày: ngoài cửa sổ HUMAN_AGENT → chắc chắn lỗi #10, gửi chỉ tốn API call
    // - <24h: khách đang chat, tránh bắn dồn dập
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const beforeTimeFilter = allCust.length;
    allCust = allCust.filter((c) => {
        const lastDate = c.lastInteraction || c.updatedAt;
        if (!lastDate) return false; // không có ngày → không xác định được cửa sổ → bỏ
        const ts = new Date(lastDate).getTime();
        if (isNaN(ts)) return false;
        return ts >= sevenDaysAgo && ts < oneDayAgo;
    });
    if (beforeTimeFilter !== allCust.length) {
        log(`  🕐 After 1–7 day window filter: ${allCust.length} (removed ${beforeTimeFilter - allCust.length})`);
    }

    const recipients = allCust.map((c) => ({
        psid: c.psid,
        pageFbId: c.pageFbId,
        name: c.customerName,
        conversationId: c.id,
    }));

    if (recipients.length === 0) {
        seg.status = "error";
        seg.error = "Không có khách hàng";
        log(`  ⚠️ No recipients after filtering`);
        return { scheduleId: schedule.id, segIdx: seg.segIdx, hour: seg.hour, recipients: 0, success: 0, errors: 0 };
    }

    // 3. Send messages in parallel batches
    let successCount = 0;
    let errorCount = 0;
    // Gửi chậm hơn để giảm nguy cơ FB chặn #2022 (spam): 8 khách/lô, giãn 2.5s giữa các lô.
    const BATCH_SIZE = 8;

    let aborted = false;
    let errLogged = 0;
    for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
        // ⛔ Huỷ bắn: client ngắt kết nối → dừng giữa các lô
        if (signal?.aborted) {
            aborted = true;
            log(`  ⛔ HUỶ BẮN tại ${successCount}/${recipients.length} (đã gửi xong các lô trước)`);
            break;
        }
        const batch = recipients.slice(i, i + BATCH_SIZE);

        const promises = batch.map(async (recipient) => {
            try {
                const hasMedia = seg.media && seg.media.length > 0;
                let res;

                if (hasMedia) {
                    // Check if media are URLs or base64
                    const isUrl = seg.media![0]?.startsWith('http');
                    
                    if (isUrl) {
                        // Media are URLs — send via JSON with images array
                        res = await fetch(`${baseUrl}/api/broadcast`, {
                            method: "POST",
                            headers: internalHeaders({ "Content-Type": "application/json" }),
                            body: JSON.stringify({
                                recipients: [recipient],
                                message: seg.message?.trim() || "",
                                images: seg.media,
                                forceGraphAPI: false,
                            }),
                            signal: AbortSignal.timeout(120000),
                        });
                    } else {
                        // Media are base64 — use FormData
                        const formData = new FormData();
                        formData.append("recipients", JSON.stringify([recipient]));
                        if (seg.message?.trim()) formData.append("message", seg.message.trim());
                        formData.append("forceGraphAPI", "false");

                        for (const dataUrl of seg.media!) {
                            const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
                            if (match) {
                                const mimeType = match[1];
                                const base64 = match[2];
                                const buffer = Buffer.from(base64, "base64");
                                const blob = new Blob([buffer], { type: mimeType });
                                const ext = mimeType.split("/")[1] || "png";
                                formData.append("images", blob, `image.${ext}`);
                            }
                        }

                        res = await fetch(`${baseUrl}/api/broadcast`, {
                            method: "POST",
                            headers: internalHeaders(),
                            body: formData,
                            signal: AbortSignal.timeout(120000),
                        });
                    }
                } else {
                    // Text only — use JSON
                    res = await fetch(`${baseUrl}/api/broadcast`, {
                        method: "POST",
                        headers: internalHeaders({ "Content-Type": "application/json" }),
                        body: JSON.stringify({
                            recipients: [recipient],
                            message: seg.message,
                            forceGraphAPI: false,
                        }),
                        signal: AbortSignal.timeout(120000),
                    });
                }

                const data = await res.json();
                if (data.results?.[0]?.success) return true;
                // Log tối đa 5 lỗi đầu của CẢ đợt (trước đây chỉ log lô đầu tiên)
                if (errLogged < 5) { errLogged++; log(`  ❌ ${recipient.name}: ${data.results?.[0]?.error || "Unknown"}`); }
                return false;
            } catch {
                return false;
            }
        });

        const batchResults = await Promise.all(promises);
        successCount += batchResults.filter(Boolean).length;
        errorCount += batchResults.filter(r => !r).length;

        log(`  📊 Progress: ${Math.min(i + BATCH_SIZE, recipients.length)}/${recipients.length} (✅${successCount} ❌${errorCount})`);

        // Delay between batches to respect rate limits
        if (i + BATCH_SIZE < recipients.length) {
            await new Promise((r) => setTimeout(r, 2500));
        }
    }

    // 4. Update segment status + counts
    seg.totalRecipients = recipients.length;
    seg.successCount = successCount;
    seg.errorCount = errorCount;

    if (aborted) {
        // Bị huỷ giữa chừng: đánh dấu đã gửi (tránh gửi trùng phần đã gửi),
        // ghi rõ là huỷ. Không thêm vào firedDates.
        seg.status = successCount > 0 ? "sent" : "pending";
        seg.sentAt = new Date().toISOString();
        seg.error = `⛔ Đã huỷ — gửi ${successCount}/${recipients.length}`;
        schedule.lastFiredAt = new Date().toISOString();
        log(`  ⛔ Aborted: ${successCount}/${recipients.length} đã gửi`);
        return {
            scheduleId: schedule.id, segIdx: seg.segIdx, hour: seg.hour,
            recipients: recipients.length, success: successCount, errors: errorCount, aborted: true,
        };
    }

    if (errorCount === 0) {
        seg.status = "sent";
        seg.sentAt = new Date().toISOString();
        if (!schedule.firedDates) schedule.firedDates = [];
        if (!schedule.firedDates.includes(todayStr)) schedule.firedDates.push(todayStr);
    } else if (successCount > 0) {
        seg.status = "sent";
        seg.sentAt = new Date().toISOString();
        seg.error = `${errorCount} lỗi / ${recipients.length} tổng`;
        if (!schedule.firedDates) schedule.firedDates = [];
        if (!schedule.firedDates.includes(todayStr)) schedule.firedDates.push(todayStr);
    } else {
        seg.status = "error";
        seg.error = `Tất cả ${errorCount} gửi thất bại`;
    }

    schedule.lastFiredAt = new Date().toISOString();
    log(`  📨 Done: ${successCount}/${recipients.length} success`);

    return {
        scheduleId: schedule.id,
        segIdx: seg.segIdx,
        hour: seg.hour,
        recipients: recipients.length,
        success: successCount,
        errors: errorCount,
    };
}

// Vercel Cron needs maxDuration for long-running jobs
export const maxDuration = 300; // 5 minutes max (Vercel Pro) or 60s (Free)
export const dynamic = "force-dynamic";
