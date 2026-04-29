import { bigquery, BQ_DATASET } from "../client";

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

const TABLE = `${BQ_DATASET}.broadcast_schedules`;

// ─── Ensure table exists ──────────────────────────────────────────────────────
let tableReady = false;

async function ensureTable() {
    if (tableReady) return;
    try {
        const query = `
            CREATE TABLE IF NOT EXISTS \`${TABLE}\` (
                id STRING NOT NULL,
                schedule_json STRING NOT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP()
            )
        `;
        await bigquery.query({ query });
        tableReady = true;
        console.log("[schedule-model] Table ready:", TABLE);
    } catch (err) {
        console.error("[schedule-model] ensureTable error:", err);
        throw err;
    }
}

// ─── Load all schedules ───────────────────────────────────────────────────────
export async function loadSchedules(): Promise<BroadcastSchedule[]> {
    await ensureTable();
    try {
        const [rows] = await bigquery.query({
            query: `SELECT id, schedule_json FROM \`${TABLE}\` ORDER BY updated_at DESC`,
        });
        return rows.map((r: { schedule_json: string }) => JSON.parse(r.schedule_json));
    } catch (err) {
        console.error("[schedule-model] loadSchedules error:", err);
        return [];
    }
}

// ─── Save (upsert) a single schedule ──────────────────────────────────────────
export async function saveSchedule(schedule: BroadcastSchedule): Promise<void> {
    await ensureTable();
    const json = JSON.stringify(schedule);
    // MERGE = upsert
    const query = `
        MERGE \`${TABLE}\` T
        USING (SELECT @id AS id, @json AS schedule_json) S
        ON T.id = S.id
        WHEN MATCHED THEN
            UPDATE SET schedule_json = S.schedule_json, updated_at = CURRENT_TIMESTAMP()
        WHEN NOT MATCHED THEN
            INSERT (id, schedule_json, updated_at) VALUES (S.id, S.schedule_json, CURRENT_TIMESTAMP())
    `;
    await bigquery.query({
        query,
        params: { id: schedule.id, json },
    });
}

// ─── Save multiple schedules at once ──────────────────────────────────────────
export async function saveSchedules(schedules: BroadcastSchedule[]): Promise<void> {
    // Simple approach: save each one (BQ MERGE is idempotent)
    for (const s of schedules) {
        await saveSchedule(s);
    }
}

// ─── Delete a schedule ────────────────────────────────────────────────────────
export async function deleteSchedule(id: string): Promise<void> {
    await ensureTable();
    await bigquery.query({
        query: `DELETE FROM \`${TABLE}\` WHERE id = @id`,
        params: { id },
    });
}

// ─── Delete all schedules ─────────────────────────────────────────────────────
export async function deleteAllSchedules(): Promise<void> {
    await ensureTable();
    await bigquery.query({ query: `TRUNCATE TABLE \`${TABLE}\`` });
}
