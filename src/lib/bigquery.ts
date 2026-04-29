import { BigQuery } from "@google-cloud/bigquery";
import path from "path";

// Initialize BigQuery client
// Supports both local file and env var (for cloud deployment like Vercel)
const projectId = process.env.NEXT_PUBLIC_BQ_PROJECT || "levelup-465304";

function createBigQueryClient() {
    // Option 1: Base64-encoded credentials in env var (for Vercel/cloud)
    if (process.env.GOOGLE_CREDENTIALS_BASE64) {
        const credentials = JSON.parse(
            Buffer.from(process.env.GOOGLE_CREDENTIALS_BASE64, "base64").toString("utf-8")
        );
        return new BigQuery({ projectId, credentials });
    }

    // Option 2: JSON string in env var
    if (process.env.GOOGLE_CREDENTIALS_JSON) {
        const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
        return new BigQuery({ projectId, credentials });
    }

    // Option 3: Local key file (for development)
    const keyFilename = path.join(process.cwd(), "config/bigquery-key.json");
    return new BigQuery({ projectId, keyFilename });
}

export const bigquery = createBigQueryClient();

export const DATASET = process.env.DATASET || "STRAMARK_Dataset";

export async function runQuery(query: string, params?: any[]) {
    try {
        const options = {
            query,
            params,
        };
        const [rows] = await bigquery.query(options);
        return rows;
    } catch (error) {
        console.error("BigQuery Error:", error);
        throw new Error("Failed to execute query");
    }
}
