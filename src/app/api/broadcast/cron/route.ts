import { NextRequest, NextResponse } from "next/server";
import {
    loadSchedules,
    saveSchedule,
    type BroadcastSchedule,
    type ScheduleSegment,
} from "@/lib/bigquery/models/talpha-schedule.model";

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

function getTodayDateStr(utcOffset: number): string {
    const now = new Date();
    const target = new Date(
        now.getTime() + utcOffset * 3600000 + now.getTimezoneOffset() * 60000
    );
    return target.toISOString().slice(0, 10);
}

function getCurrentDecimal(utcOffset: number): number {
    const now = new Date();
    const target = new Date(
        now.getTime() + utcOffset * 3600000 + now.getTimezoneOffset() * 60000
    );
    return target.getHours() + target.getMinutes() / 60;
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
        // ── Security: Vercel sets CRON_SECRET header for cron jobs ──
        // For manual trigger, accept ?secret= query param
        const authHeader = req.headers.get("authorization");
        const cronSecret = process.env.CRON_SECRET;
        const querySecret = new URL(req.url).searchParams.get("secret");

        if (cronSecret) {
            const isVercelCron = authHeader === `Bearer ${cronSecret}`;
            const isManualTrigger = querySecret === cronSecret;
            if (!isVercelCron && !isManualTrigger) {
                return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
            }
        }

        log("⏰ Cron job started");

        const schedules = await loadSchedules();
        log(`📋 Loaded ${schedules.length} schedules from BigQuery`);

        if (schedules.length === 0) {
            return NextResponse.json({ ok: true, message: "No schedules", logs });
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

            for (const seg of schedule.segments) {
                // Reset status if new day
                if (schedule.lastRunDate && schedule.lastRunDate !== todayStr) {
                    seg.status = "pending";
                    seg.error = undefined;
                    seg.sentAt = undefined;
                }

                // Skip already sent today
                if (seg.status === "sent" && schedule.lastRunDate === todayStr) {
                    log(`  ✅ Seg ${seg.segIdx} (${seg.hour}h) already sent today`);
                    continue;
                }
                // Skip currently sending (race condition guard)
                if (seg.status === "sending") {
                    log(`  ⏳ Seg ${seg.segIdx} (${seg.hour}h) currently sending, skip`);
                    continue;
                }

                // Check if it's time to fire
                if (currentDecimal >= seg.hour && seg.status !== "sent") {
                    log(`  🔥 FIRING Seg ${seg.segIdx} (${seg.hour}h) — current time ${currentDecimal.toFixed(2)}h`);

                    seg.status = "sending";
                    schedule.lastRunDate = todayStr;
                    await saveSchedule(schedule);

                    try {
                        const fired = await fireSegment(schedule, seg, todayStr, log);
                        results.push(fired);
                        totalFired++;
                    } catch (err) {
                        seg.status = "error";
                        seg.error = err instanceof Error ? err.message : String(err);
                        log(`  ❌ Seg ${seg.segIdx} error: ${seg.error}`);
                    }

                    await saveSchedule(schedule);

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

// ─── Fire a single segment ────────────────────────────────────────────────────
async function fireSegment(
    schedule: BroadcastSchedule,
    seg: ScheduleSegment,
    todayStr: string,
    log: (msg: string) => void
): Promise<{ scheduleId: string; segIdx: number; hour: number; recipients: number; success: number; errors: number }> {
    // 1. Fetch customers for this shop+page
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL
        || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
        || "https://talpha-dashboard.vercel.app";

    const custUrl = `${baseUrl}/api/broadcast?shopId=${schedule.shopId}&pageFilter=${schedule.pageId}`;
    log(`  📡 Fetching customers: ${custUrl.replace(/api_key=[^&]+/, "api_key=***")}`);

    const custRes = await fetch(custUrl);
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
    const BATCH_SIZE = 20;

    for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
        const batch = recipients.slice(i, i + BATCH_SIZE);
        
        const promises = batch.map(async (recipient) => {
            try {
                const res = await fetch(`${baseUrl}/api/broadcast`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        recipients: [recipient],
                        message: seg.message,
                        forceGraphAPI: false, // fallback to Pancake CRM API because Talpha Bot app was deleted
                    }),
                });
                const data = await res.json();
                if (data.results?.[0]?.success) return true;
                if (i === 0) log(`  ❌ ${recipient.name}: ${data.results?.[0]?.error || "Unknown"}`);
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
            await new Promise((r) => setTimeout(r, 1000));
        }
    }

    // 4. Update segment status
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
