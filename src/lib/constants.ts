/**
 * Frontend constants — shared across all client components.
 *
 * ⚠️ RULE: NEVER hardcode dataset/project names in SQL queries.
 *    Always use DATASET from this file.
 *
 * To change dataset for a new project, set the env var:
 *    NEXT_PUBLIC_DATASET=NewProject_Dataset
 */

export const DATASET = process.env.NEXT_PUBLIC_DATASET || "TALPHA_Dataset";
export const BQ_PROJECT = process.env.NEXT_PUBLIC_BQ_PROJECT || "levelup-465304";
export const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME || "TALPHA Broadcast";
export const APP_VERSION = "v1.0";

// Currency + exchange rates (USD → VND for display).
// TALPHA bán đa thị trường (Trung Đông/Nhật/Đài) nên không cố định 1 đơn vị tiền.
export const CURRENCY_SYMBOL = "USD";
export const EXCHANGE_RATE_USD_TO_VND = 25400;    // USD → VND
