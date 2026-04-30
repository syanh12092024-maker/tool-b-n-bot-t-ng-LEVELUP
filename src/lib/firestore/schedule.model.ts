import fs from "fs";
import path from "path";
import { GoogleAuth } from "google-auth-library";

// ─── Types ────────────────────────────────────────────────────────────────────
export interface ScheduleSegment {
    segIdx: number;
    hour: number;
    message: string;
    media?: string[];
    status?: "pending" | "sending" | "sent" | "error";
    error?: string;
    sentAt?: string;
    totalRecipients?: number;
    successCount?: number;
    errorCount?: number;
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
    filterPurchase?: string;
    filterTimeRange?: string;
    isActive: boolean;
    createdAt: string;
    lastFiredAt: string | null;
    nextFireAt: string | null;
    note?: string;
    recipientCount?: number;
}

// ─── Config ───────────────────────────────────────────────────────────────────
const PROJECT_ID = "banbot-494807";
const DATABASE_ID = "talpha";
const COLLECTION = "broadcast_schedules";
const KEY_PATH = path.resolve(process.cwd(), "config/firestore-key.json");

const BASE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents`;

// ─── Auth helper ──────────────────────────────────────────────────────────────
let authClient: GoogleAuth | null = null;

async function getAccessToken(): Promise<string> {
    if (!authClient) {
        authClient = new GoogleAuth({
            keyFile: KEY_PATH,
            scopes: ["https://www.googleapis.com/auth/datastore"],
        });
    }
    const client = await authClient.getClient();
    const token = await client.getAccessToken();
    return token.token || "";
}

// ─── Firestore value helpers ──────────────────────────────────────────────────
function toFirestoreValue(val: unknown): Record<string, unknown> {
    if (val === null || val === undefined) return { nullValue: null };
    if (typeof val === "string") return { stringValue: val };
    if (typeof val === "number") {
        return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
    }
    if (typeof val === "boolean") return { booleanValue: val };
    if (Array.isArray(val)) {
        return { arrayValue: { values: val.map(toFirestoreValue) } };
    }
    if (typeof val === "object") {
        const fields: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
            fields[k] = toFirestoreValue(v);
        }
        return { mapValue: { fields } };
    }
    return { stringValue: String(val) };
}

function fromFirestoreValue(val: Record<string, unknown>): unknown {
    if ("nullValue" in val) return null;
    if ("stringValue" in val) return val.stringValue;
    if ("integerValue" in val) return Number(val.integerValue);
    if ("doubleValue" in val) return val.doubleValue;
    if ("booleanValue" in val) return val.booleanValue;
    if ("arrayValue" in val) {
        const arr = val.arrayValue as { values?: Record<string, unknown>[] };
        return (arr.values || []).map(fromFirestoreValue);
    }
    if ("mapValue" in val) {
        const map = val.mapValue as { fields?: Record<string, Record<string, unknown>> };
        const result: Record<string, unknown> = {};
        if (map.fields) {
            for (const [k, v] of Object.entries(map.fields)) {
                result[k] = fromFirestoreValue(v);
            }
        }
        return result;
    }
    return null;
}

function docToSchedule(doc: { name: string; fields: Record<string, Record<string, unknown>> }): BroadcastSchedule {
    const id = doc.name.split("/").pop() || "";
    const data: Record<string, unknown> = {};
    if (doc.fields) {
        for (const [k, v] of Object.entries(doc.fields)) {
            data[k] = fromFirestoreValue(v);
        }
    }
    return { id, ...data } as BroadcastSchedule;
}

function scheduleToFields(schedule: BroadcastSchedule): Record<string, unknown> {
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schedule)) {
        if (k === "id") continue; // id is in the doc path
        fields[k] = toFirestoreValue(v);
    }
    return fields;
}

// ─── Load all schedules ───────────────────────────────────────────────────────
export async function loadSchedules(): Promise<BroadcastSchedule[]> {
    try {
        const token = await getAccessToken();
        const res = await fetch(`${BASE_URL}/${COLLECTION}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
            const errText = await res.text();
            console.error("[firestore-rest] loadSchedules HTTP error:", res.status, errText);
            return [];
        }
        const data = await res.json();
        const docs = data.documents || [];
        const schedules = docs.map(docToSchedule);
        console.log(`[firestore-rest] Loaded ${schedules.length} schedules`);
        return schedules;
    } catch (error: unknown) {
        const err = error as Error;
        console.error("[firestore-rest] loadSchedules error:", err.message);
        return [];
    }
}

// ─── Save (upsert) a schedule ─────────────────────────────────────────────────
export async function saveSchedule(schedule: BroadcastSchedule): Promise<void> {
    try {
        const token = await getAccessToken();
        const docUrl = `${BASE_URL}/${COLLECTION}/${schedule.id}`;
        const body = { fields: scheduleToFields(schedule) };
        const res = await fetch(docUrl, {
            method: "PATCH",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`HTTP ${res.status}: ${errText}`);
        }
        console.log(`[firestore-rest] Saved schedule: ${schedule.id}`);
    } catch (error: unknown) {
        const err = error as Error;
        console.error("[firestore-rest] saveSchedule error:", err.message);
        throw error;
    }
}

// ─── Delete a schedule ────────────────────────────────────────────────────────
export async function deleteSchedule(id: string): Promise<void> {
    try {
        const token = await getAccessToken();
        const docUrl = `${BASE_URL}/${COLLECTION}/${id}`;
        const res = await fetch(docUrl, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`HTTP ${res.status}: ${errText}`);
        }
        console.log(`[firestore-rest] Deleted schedule: ${id}`);
    } catch (error: unknown) {
        const err = error as Error;
        console.error("[firestore-rest] deleteSchedule error:", err.message);
        throw error;
    }
}
