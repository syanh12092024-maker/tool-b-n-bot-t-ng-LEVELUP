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

export async function runQuery(query: string, params?: Record<string, any>) {
    try {
        const [rows] = await bigquery.query({ query, params });
        return rows;
    } catch (error) {
        console.error("BigQuery Error:", error);
        throw error;
    }
}
