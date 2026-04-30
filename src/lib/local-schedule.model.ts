import fs from "fs";
import path from "path";

// ─── Types ────────────────────────────────────────────────────────────────────
export interface ScheduleSegment {
    segIdx: number;
    hour: number;
    message: string;
    status?: "pending" | "sending" | "sent" | "error";
    error?: string;
    sentAt?: string;
}

export interface BroadcastSchedule {
    id: string;
    shopId: string;
    shopName: string;
    pageId: string;
    pageName: string;
    hour: number;
    messages: string[];
    segments?: ScheduleSegment[];
    filterPurchase: string;
    filterTimeRange: string;
    isActive: boolean;
    createdAt: string;
    lastFiredAt: string | null;
    nextFireAt: string | null;
    note?: string;
    lastSegmentIndex?: number;
    lastRunDate?: string;
    firedDates?: string[];
}

// ─── Local JSON file storage ──────────────────────────────────────────────────
const DATA_DIR = path.join(process.cwd(), "data");
const SCHEDULES_FILE = path.join(DATA_DIR, "broadcast-schedules.json");

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        console.log("[schedule-local] Created data directory:", DATA_DIR);
    }
}

function readSchedulesFile(): BroadcastSchedule[] {
    ensureDataDir();
    try {
        if (fs.existsSync(SCHEDULES_FILE)) {
            const raw = fs.readFileSync(SCHEDULES_FILE, "utf-8");
            return JSON.parse(raw);
        }
    } catch (err) {
        console.error("[schedule-local] Read error:", err);
    }
    return [];
}

function writeSchedulesFile(schedules: BroadcastSchedule[]) {
    ensureDataDir();
    fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(schedules, null, 2), "utf-8");
}

// ─── Load all schedules ───────────────────────────────────────────────────────
export async function loadSchedules(): Promise<BroadcastSchedule[]> {
    return readSchedulesFile();
}

// ─── Save (upsert) a single schedule ──────────────────────────────────────────
export async function saveSchedule(schedule: BroadcastSchedule): Promise<void> {
    const schedules = readSchedulesFile();
    const idx = schedules.findIndex(s => s.id === schedule.id);
    if (idx >= 0) {
        schedules[idx] = schedule;
    } else {
        schedules.push(schedule);
    }
    writeSchedulesFile(schedules);
    console.log(`[schedule-local] Saved schedule ${schedule.id}`);
}

// ─── Save multiple schedules at once ──────────────────────────────────────────
export async function saveSchedules(schedules: BroadcastSchedule[]): Promise<void> {
    for (const s of schedules) {
        await saveSchedule(s);
    }
}

// ─── Delete a schedule ────────────────────────────────────────────────────────
export async function deleteSchedule(id: string): Promise<void> {
    const schedules = readSchedulesFile();
    const filtered = schedules.filter(s => s.id !== id);
    writeSchedulesFile(filtered);
    console.log(`[schedule-local] Deleted schedule ${id}`);
}

// ─── Delete all schedules ─────────────────────────────────────────────────────
export async function deleteAllSchedules(): Promise<void> {
    writeSchedulesFile([]);
    console.log("[schedule-local] Deleted all schedules");
}
