import { Firestore } from "@google-cloud/firestore";
import path from "path";

const keyPath = path.resolve(process.cwd(), "config/firestore-key.json");
const projectId = "banbot-494807";
const databaseId = "talpha";

export const firestore = new Firestore({
    projectId,
    keyFilename: keyPath,
    databaseId,
});

console.log(`[firestore] Initialized for project: ${projectId}, database: ${databaseId}`);
