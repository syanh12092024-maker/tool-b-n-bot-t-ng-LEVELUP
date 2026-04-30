import { BigQuery } from "@google-cloud/bigquery";
import path from "path";

// Updated path to reference the shared config safely
const keyFilename = path.resolve(process.cwd(), "config/bigquery-key.json");
const projectId = "levelup-465304";

export const bigquery = new BigQuery({
    projectId,
    keyFilename,
});

export const BQ_DATASET = "TALPHA_Dataset";

// ─── Auto-create dataset if not exists ────────────────────────────────────────
let datasetReady = false;

export async function ensureDataset() {
    if (datasetReady) return;
    try {
        const dataset = bigquery.dataset(BQ_DATASET);
        const [exists] = await dataset.exists();
        if (!exists) {
            await bigquery.createDataset(BQ_DATASET, { location: "US" });
            console.log(`[bigquery] Created dataset: ${BQ_DATASET}`);
        }
        datasetReady = true;
        console.log(`[bigquery] Dataset ready: ${BQ_DATASET}`);
    } catch (err) {
        console.error("[bigquery] ensureDataset error:", err);
        throw err;
    }
}

export async function runQuery(query: string, params?: Record<string, any>) {
    try {
        await ensureDataset();
        const [rows] = await bigquery.query({ query, params });
        return rows;
    } catch (error) {
        console.error("BigQuery Error:", error);
        throw error;
    }
}
