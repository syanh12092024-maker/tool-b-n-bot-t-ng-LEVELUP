import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { query, queryOne } from "./db";

/**
 * Ảnh lưu TRONG DATABASE, không để trên đĩa.
 *
 * Bản v1 hỏng đúng chỗ này: ghi ảnh vào public/uploads rồi gửi link đi, nhưng
 * Next.js không phục vụ file ghi thêm sau khi build — khách nhận được link chết.
 * Để trong DB thì không phụ thuộc quyền ghi, sống qua mọi lần deploy lại, và
 * được sao lưu cùng dữ liệu.
 */

const MAX_INPUT = 12 * 1024 * 1024; // 12MB đầu vào
const MAX_WIDTH = 1200;
const JPEG_QUALITY = 78;
const COMPRESS_OVER = 200 * 1024; // nén ảnh lớn hơn 200KB

export interface StoredMedia {
    id: string;
    url: string;
    size: number;
    mime: string;
}

export async function storeImage(
    input: Buffer,
    mime: string,
    pageDbId: number | null,
    publicBase: string
): Promise<StoredMedia> {
    if (input.length > MAX_INPUT) {
        throw new Error(`Ảnh quá lớn (${Math.round(input.length / 1024 / 1024)}MB) — tối đa 12MB`);
    }
    if (!mime.startsWith("image/")) {
        throw new Error(`Chỉ nhận ảnh, không nhận ${mime || "tệp không rõ loại"}`);
    }

    let bytes = input;
    let outMime = mime;
    // Nén trước khi lưu: ảnh to làm Facebook từ chối và làm chậm cả đợt gửi
    if (input.length > COMPRESS_OVER) {
        try {
            bytes = await sharp(input)
                .resize({ width: MAX_WIDTH, withoutEnlargement: true })
                .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
                .toBuffer();
            outMime = "image/jpeg";
        } catch {
            // Nén hỏng thì giữ ảnh gốc — thà nặng còn hơn mất ảnh
        }
    }

    const id = randomBytes(9).toString("base64url");
    await query(`INSERT INTO media (id, mime, bytes, size, page_id) VALUES ($1, $2, $3, $4, $5)`, [
        id,
        outMime,
        bytes,
        bytes.length,
        pageDbId,
    ]);
    return { id, url: `${publicBase}/api/media/${id}`, size: bytes.length, mime: outMime };
}

export function loadImage(id: string) {
    return queryOne<{ mime: string; bytes: Buffer }>(`SELECT mime, bytes FROM media WHERE id = $1`, [id]);
}

/**
 * Địa chỉ công khai để chèn vào link ảnh.
 *
 * PHẢI là địa chỉ Facebook/Pancake vào được từ ngoài — không phải localhost.
 * Sai chỗ này thì tin gửi đi mang link chết mà không có lỗi nào báo.
 */
export function publicBase(req: Request): string {
    const configured = process.env.PUBLIC_URL?.replace(/\/+$/, "");
    if (configured) return configured;
    const h = new Headers(req.headers);
    const proto = h.get("x-forwarded-proto") ?? "http";
    const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3001";
    return `${proto}://${host}`;
}
