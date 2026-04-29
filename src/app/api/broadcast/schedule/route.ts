import { NextRequest, NextResponse } from "next/server";
import {
    loadSchedules,
    saveSchedule,
    deleteSchedule,
    type BroadcastSchedule,
} from "@/lib/bigquery/models/talpha-schedule.model";

// ─── GET: Lấy tất cả schedules từ BigQuery ───────────────────────────────────
export async function GET() {
    try {
        const schedules = await loadSchedules();
        return NextResponse.json({ schedules });
    } catch (err) {
        console.error("[schedule-api] GET error:", err);
        return NextResponse.json(
            { error: err instanceof Error ? err.message : "Unknown error" },
            { status: 500 }
        );
    }
}

// ─── POST: Lưu / Cập nhật / Xoá schedule ─────────────────────────────────────
export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { action, schedule, scheduleId } = body as {
            action: "save" | "delete" | "toggle" | "save_note";
            schedule?: BroadcastSchedule;
            scheduleId?: string;
        };

        switch (action) {
            case "save": {
                if (!schedule) {
                    return NextResponse.json({ error: "Missing schedule data" }, { status: 400 });
                }
                await saveSchedule(schedule);
                return NextResponse.json({ ok: true, id: schedule.id });
            }

            case "delete": {
                if (!scheduleId) {
                    return NextResponse.json({ error: "Missing scheduleId" }, { status: 400 });
                }
                await deleteSchedule(scheduleId);
                return NextResponse.json({ ok: true });
            }

            case "toggle": {
                if (!scheduleId) {
                    return NextResponse.json({ error: "Missing scheduleId" }, { status: 400 });
                }
                const all = await loadSchedules();
                const target = all.find(s => s.id === scheduleId);
                if (!target) {
                    return NextResponse.json({ error: "Schedule not found" }, { status: 404 });
                }
                target.isActive = !target.isActive;
                await saveSchedule(target);
                return NextResponse.json({ ok: true, isActive: target.isActive });
            }

            case "save_note": {
                if (!scheduleId) {
                    return NextResponse.json({ error: "Missing scheduleId" }, { status: 400 });
                }
                const allSchedules = await loadSchedules();
                const noteTarget = allSchedules.find(s => s.id === scheduleId);
                if (!noteTarget) {
                    return NextResponse.json({ error: "Schedule not found" }, { status: 404 });
                }
                noteTarget.note = body.note ?? "";
                await saveSchedule(noteTarget);
                return NextResponse.json({ ok: true });
            }

            default:
                return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
        }
    } catch (err) {
        console.error("[schedule-api] POST error:", err);
        return NextResponse.json(
            { error: err instanceof Error ? err.message : "Unknown error" },
            { status: 500 }
        );
    }
}
