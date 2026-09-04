"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";

/**
 * Giao diện vận hành bắn bot.
 *
 * Chia làm BA màn hình theo ba việc khác nhau, thay vì dồn tất cả vào một trang
 * cuộn dài như bản trước:
 *
 *   Tổng quan  — page nào đang chạy, còn bao nhiêu khách, đã có kịch bản chưa
 *   Kịch bản   — soạn 12 tin của chuỗi nuôi dưỡng, bày thành lưới 3 cụm × 4 khung giờ
 *   Bắn tay    — chọn khách trong bảng rồi gửi ngay một tin
 *
 * Trước đây hai việc "soạn kịch bản tự động" và "bắn tay cho khách đã chọn"
 * dùng chung một bộ ô soạn, dễ nhầm: sửa nội dung định để bắn tay lại hoá ra
 * đang sửa kịch bản đang chạy.
 */

// ─── Hằng số khung giờ ────────────────────────────────────────────────────────
const SLOT_HOURS = [6, 11, 17, 21];
const CUM = [
    { key: "A", name: "Giới thiệu", hint: "Chào hỏi, báo giá, công dụng, cách đặt" },
    { key: "B", name: "Bằng chứng", hint: "Feedback khách, cam kết, gỡ băn khoăn" },
    { key: "C", name: "Thúc chốt", hint: "Ưu đãi, khan hàng, xin thông tin" },
];
const SLOT_COUNT = SLOT_HOURS.length * CUM.length;

const DAYPART = [
    { label: "Sáng", color: "var(--dawn)" },
    { label: "Trưa", color: "var(--noon)" },
    { label: "Chiều", color: "var(--dusk)" },
    { label: "Tối", color: "var(--night)" },
];

const GOI_Y = [
    "Chào + trả lời ngay câu khách hay hỏi nhất",
    "Báo giá, phí ship, hình thức thanh toán",
    "Công dụng chính, nối tiếp lời hứa của quảng cáo",
    "Cách dùng / cách đặt hàng",
    "Ảnh hoặc lời của khách đã mua",
    "Gỡ băn khoăn phổ biến nhất",
    "Gỡ băn khoăn thứ hai",
    "Cam kết: kiểm hàng trước khi trả tiền",
    "Ưu đãi có hạn",
    "Khan hàng, giữ chỗ",
    "Hỏi thẳng để lấy tên + SĐT + địa chỉ",
    "Tin cuối, để ngỏ cửa quay lại",
];

// ─── Kiểu dữ liệu ─────────────────────────────────────────────────────────────
interface PageInfo {
    pageId: string;
    name: string;
    shopName: string;
    isActive: boolean;
    health: string;
    rampPercent: number;
    hasScript: boolean;
    activeCustomers: number;
    totalCustomers: number;
    lastSyncedAt: string | null;
}

interface Customer {
    id: string;
    customerName: string;
    customerPhone: string;
    psid: string;
    tags: string[];
    lastInteraction: string;
    status: string;
    journeyDay: number;
    orderCount: number;
}

interface Segment {
    segIdx: number;
    hour: number;
    label: string;
    message: string;
    media: string[];
    successCount: number;
    errorCount: number;
}

interface Schedule {
    pageId: string;
    pageName: string;
    segments: Segment[];
    isActive: boolean;
    recipientCount: number;
    hasScript: boolean;
    health: string;
}

type Screen = "tong-quan" | "kich-ban" | "ban-tay";

// ─── Gọi API ──────────────────────────────────────────────────────────────────
const KEY_STORE = "banbot_key";

if (typeof window !== "undefined") {
    try {
        const u = new URL(window.location.href);
        const k = u.searchParams.get("key");
        if (k?.trim()) {
            localStorage.setItem(KEY_STORE, k.trim());
            u.searchParams.delete("key");
            window.history.replaceState({}, "", u.toString());
        }
    } catch {
        /* bỏ qua */
    }
}

async function apiFetch(url: string, init?: RequestInit): Promise<Response> {
    const key = typeof window !== "undefined" ? localStorage.getItem(KEY_STORE) ?? "" : "";
    const headers = new Headers(init?.headers);
    if (key) headers.set("x-app-key", key);
    const res = await fetch(url, { ...init, headers });
    // Máy chủ đặt mật khẩu ở tầng nginx nên bình thường không gặp 401 ở đây.
    // Giữ nhánh này cho trường hợp chạy trực tiếp khi phát triển.
    if (res.status === 401 && typeof window !== "undefined") {
        const entered = window.prompt("Nhập mã truy cập:");
        if (entered?.trim()) {
            localStorage.setItem(KEY_STORE, entered.trim());
            headers.set("x-app-key", entered.trim());
            return fetch(url, { ...init, headers });
        }
    }
    return res;
}

// ─── Tiện ích ─────────────────────────────────────────────────────────────────
function ago(iso: string): string {
    if (!iso) return "—";
    const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (!Number.isFinite(s)) return "—";
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))} phút trước`;
    if (s < 86400) return `${Math.round(s / 3600)} giờ trước`;
    return `${Math.round(s / 86400)} ngày trước`;
}

function num(n: number): string {
    return n.toLocaleString("vi-VN");
}

// ─── Thành phần dùng chung ────────────────────────────────────────────────────

function Chip({ kind, children }: { kind: "ok" | "warn" | "bad" | "brand" | "muted"; children: React.ReactNode }) {
    return <span className={`chip chip-${kind}`}>{children}</span>;
}

function PageStateChip({ p }: { p: { isActive: boolean; health: string } }) {
    if (!p.isActive) return <Chip kind="muted">Đang tắt</Chip>;
    if (p.health === "paused") return <Chip kind="bad">Tạm ngưng</Chip>;
    if (p.health === "degraded") return <Chip kind="warn">Hãm tốc</Chip>;
    return <Chip kind="ok">Đang chạy</Chip>;
}

function Stat({ value, label, hint, tone }: { value: string; label: string; hint?: string; tone?: string }) {
    return (
        <div className="surface px-4 py-3">
            <div className="num text-[26px] font-bold leading-tight" style={tone ? { color: tone } : undefined}>
                {value}
            </div>
            <div className="mt-0.5 text-[13px]" style={{ color: "var(--ink-2)" }}>
                {label}
            </div>
            {hint && (
                <div className="mt-0.5 text-[12px]" style={{ color: "var(--ink-3)" }}>
                    {hint}
                </div>
            )}
        </div>
    );
}

function Empty({ title, hint, action }: { title: string; hint?: string; action?: React.ReactNode }) {
    return (
        <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
            <div className="text-[15px] font-semibold">{title}</div>
            {hint && (
                <div className="mt-1.5 max-w-md text-[13.5px]" style={{ color: "var(--ink-3)" }}>
                    {hint}
                </div>
            )}
            {action && <div className="mt-4">{action}</div>}
        </div>
    );
}

// ═══ MÀN HÌNH 1 · TỔNG QUAN ═══════════════════════════════════════════════════

function OverviewScreen({
    pages,
    loading,
    onPick,
}: {
    pages: PageInfo[];
    loading: boolean;
    onPick: (pageId: string, screen: Screen) => void;
}) {
    const totals = useMemo(
        () => ({
            active: pages.filter((p) => p.isActive).length,
            customers: pages.reduce((a, p) => a + p.activeCustomers, 0),
            noScript: pages.filter((p) => !p.hasScript).length,
            paused: pages.filter((p) => p.isActive && p.health === "paused").length,
        }),
        [pages]
    );

    return (
        <div className="space-y-5">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Stat value={num(totals.active)} label="Page đang chạy" hint={`trên tổng ${pages.length} page`} />
                <Stat
                    value={num(totals.customers)}
                    label="Khách gửi được"
                    hint="còn trong cửa sổ 7 ngày"
                    tone="var(--brand)"
                />
                <Stat
                    value={num(totals.noScript)}
                    label="Page chưa có kịch bản"
                    hint={totals.noScript ? "chưa gửi được gì" : "đủ cả"}
                    tone={totals.noScript ? "var(--warn)" : undefined}
                />
                <Stat
                    value={num(totals.paused)}
                    label="Page bị tạm ngưng"
                    hint={totals.paused ? "Facebook đang siết" : "không có"}
                    tone={totals.paused ? "var(--bad)" : undefined}
                />
            </div>

            <div className="panel overflow-hidden">
                <div className="flex items-center justify-between border-b px-5 py-3.5" style={{ borderColor: "var(--line)" }}>
                    <h2 className="text-[15px] font-bold">Các page</h2>
                    <span className="text-[12.5px]" style={{ color: "var(--ink-3)" }}>
                        Bấm vào một page để soạn kịch bản hoặc bắn tay
                    </span>
                </div>

                {loading ? (
                    <Empty title="Đang tải danh sách page…" />
                ) : pages.length === 0 ? (
                    <Empty
                        title="Chưa có page nào"
                        hint="Thêm page bằng dòng lệnh trên máy chủ: npm run page:add -- --page <id> --market Saudi"
                    />
                ) : (
                    <div className="overflow-x-auto">
                        <table className="tbl min-w-[860px]">
                            <thead>
                                <tr>
                                    <th>Page</th>
                                    <th>Thị trường</th>
                                    <th>Trạng thái</th>
                                    <th className="text-right">Gửi được</th>
                                    <th className="text-right">Tổng tệp</th>
                                    <th>Kịch bản</th>
                                    <th>Đồng bộ</th>
                                    <th />
                                </tr>
                            </thead>
                            <tbody>
                                {pages.map((p) => (
                                    <tr key={p.pageId}>
                                        <td>
                                            <div className="font-semibold">{p.name}</div>
                                            <div className="mono" style={{ color: "var(--ink-3)" }}>
                                                {p.pageId}
                                            </div>
                                        </td>
                                        <td style={{ color: "var(--ink-2)" }}>{p.shopName}</td>
                                        <td>
                                            <div className="flex flex-wrap items-center gap-1.5">
                                                <PageStateChip p={p} />
                                                {p.isActive && p.rampPercent < 100 && (
                                                    <Chip kind="warn">khởi động {p.rampPercent}%</Chip>
                                                )}
                                            </div>
                                        </td>
                                        <td className="num text-right font-bold">{num(p.activeCustomers)}</td>
                                        <td className="num text-right" style={{ color: "var(--ink-3)" }}>
                                            {num(p.totalCustomers)}
                                        </td>
                                        <td>
                                            {p.hasScript ? (
                                                <Chip kind="ok">đã có</Chip>
                                            ) : (
                                                <Chip kind="warn">chưa có</Chip>
                                            )}
                                        </td>
                                        <td style={{ color: "var(--ink-3)" }}>{ago(p.lastSyncedAt ?? "")}</td>
                                        <td className="text-right">
                                            <div className="flex justify-end gap-1.5">
                                                <button
                                                    className="btn btn-ghost btn-sm"
                                                    onClick={() => onPick(p.pageId, "kich-ban")}
                                                >
                                                    Kịch bản
                                                </button>
                                                <button
                                                    className="btn btn-ghost btn-sm"
                                                    onClick={() => onPick(p.pageId, "ban-tay")}
                                                >
                                                    Bắn tay
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </div>
    );
}

// ═══ MÀN HÌNH 2 · KỊCH BẢN ════════════════════════════════════════════════════

function SlotCard({
    idx,
    label,
    body,
    media,
    uploading,
    onLabel,
    onBody,
    onPaste,
    onDrop,
    onPickFile,
    onRemoveMedia,
}: {
    idx: number;
    label: string;
    body: string;
    media: string[];
    uploading: boolean;
    onLabel: (v: string) => void;
    onBody: (v: string) => void;
    onPaste: (e: React.ClipboardEvent) => void;
    onDrop: (e: React.DragEvent) => void;
    onPickFile: (e: React.ChangeEvent<HTMLInputElement>) => void;
    onRemoveMedia: (i: number) => void;
}) {
    const slot = idx % SLOT_HOURS.length;
    const dp = DAYPART[slot]!;
    const empty = !body.trim() && media.length === 0;

    return (
        <div
            className="surface flex flex-col p-3.5"
            style={empty ? { borderColor: "var(--warn)" } : undefined}
            onDrop={onDrop}
            onDragOver={(e) => e.preventDefault()}
        >
            <div className="mb-2 flex items-center gap-2">
                <span
                    className="num flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[12px] font-bold text-white"
                    style={{ background: dp.color }}
                >
                    {idx + 1}
                </span>
                <span className="text-[12px] font-semibold" style={{ color: dp.color }}>
                    {SLOT_HOURS[slot]}h · {dp.label}
                </span>
                {empty && (
                    <span className="ml-auto">
                        <Chip kind="warn">trống</Chip>
                    </span>
                )}
            </div>

            <input
                className="field mb-2 !px-2.5 !py-1.5 !text-[12.5px]"
                value={label}
                onChange={(e) => onLabel(e.target.value)}
                placeholder="nhãn ghi nhớ"
            />

            <textarea
                className="field flex-1 resize-y !text-[13.5px] leading-relaxed"
                rows={5}
                value={body}
                onChange={(e) => onBody(e.target.value)}
                onPaste={onPaste}
                placeholder={uploading ? "Đang tải ảnh lên…" : GOI_Y[idx]}
            />

            <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {media.map((url, i) => (
                    <span key={url + i} className="relative">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                            src={url}
                            alt=""
                            className="h-11 w-11 rounded-md border object-cover"
                            style={{ borderColor: "var(--line)" }}
                        />
                        <button
                            onClick={() => onRemoveMedia(i)}
                            title="Bỏ ảnh này"
                            className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold text-white"
                            style={{ background: "var(--bad)" }}
                        >
                            ×
                        </button>
                    </span>
                ))}
                <label
                    className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-md border border-dashed text-[17px]"
                    style={{ borderColor: "var(--line)", color: "var(--ink-3)" }}
                    title="Thêm ảnh — hoặc dán thẳng vào ô nội dung"
                >
                    +
                    <input type="file" accept="image/*" multiple className="hidden" onChange={onPickFile} />
                </label>
            </div>
        </div>
    );
}

function ScriptScreen({
    page,
    schedule,
    msgs,
    medias,
    labels,
    uploadingSlot,
    saving,
    onLabel,
    onBody,
    onPaste,
    onDrop,
    onPickFile,
    onRemoveMedia,
    onSave,
    onToggleActive,
}: {
    page: PageInfo;
    schedule: Schedule | null;
    msgs: string[];
    medias: string[][];
    labels: string[];
    uploadingSlot: number | null;
    saving: boolean;
    onLabel: (i: number, v: string) => void;
    onBody: (i: number, v: string) => void;
    onPaste: (i: number) => (e: React.ClipboardEvent) => void;
    onDrop: (i: number) => (e: React.DragEvent) => void;
    onPickFile: (i: number) => (e: React.ChangeEvent<HTMLInputElement>) => void;
    onRemoveMedia: (i: number, m: number) => void;
    onSave: () => void;
    onToggleActive: () => void;
}) {
    const filled = msgs.filter((m, i) => m.trim() || medias[i]!.length).length;
    const sent = schedule?.segments.reduce((a, s) => a + s.successCount, 0) ?? 0;

    return (
        <div className="space-y-5">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Stat
                    value={`${filled}/${SLOT_COUNT}`}
                    label="Ô đã nhập"
                    hint={filled === SLOT_COUNT ? "đủ cả" : `còn ${SLOT_COUNT - filled} ô trống`}
                    tone={filled === SLOT_COUNT ? "var(--ok)" : "var(--warn)"}
                />
                <Stat value={num(page.activeCustomers)} label="Khách sẽ nhận" hint="còn trong cửa sổ 7 ngày" />
                <Stat value={num(sent)} label="Tin đã gửi" hint="từ kịch bản này" />
                <Stat
                    value={page.isActive ? "Đang chạy" : "Đang tắt"}
                    label="Trạng thái page"
                    hint={page.isActive ? "engine đang gửi theo lịch" : "chưa gửi gì"}
                    tone={page.isActive ? "var(--ok)" : "var(--ink-3)"}
                />
            </div>

            <div className="panel">
                <div
                    className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3.5"
                    style={{ borderColor: "var(--line)" }}
                >
                    <div>
                        <h2 className="text-[15px] font-bold">Chuỗi nuôi dưỡng — {SLOT_COUNT} tin</h2>
                        <p className="mt-0.5 text-[12.5px]" style={{ color: "var(--ink-3)" }}>
                            Mỗi khách đi hết 7 ngày, mỗi ngày nhận 4 tin. Tin lặp lại sau đúng 3 ngày.
                        </p>
                    </div>
                    <button className="btn btn-primary" onClick={onSave} disabled={saving || filled === 0}>
                        {saving ? "Đang lưu…" : "Lưu kịch bản"}
                    </button>
                </div>

                <div className="space-y-5 p-4">
                    {CUM.map((cum, ci) => (
                        <section key={cum.key}>
                            <div className="mb-2 flex items-baseline gap-2.5">
                                <h3 className="text-[13.5px] font-bold">
                                    Cụm {cum.key} · {cum.name}
                                </h3>
                                <span className="text-[12px]" style={{ color: "var(--ink-3)" }}>
                                    {cum.hint}
                                </span>
                            </div>
                            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                                {SLOT_HOURS.map((_, si) => {
                                    const idx = ci * SLOT_HOURS.length + si;
                                    return (
                                        <SlotCard
                                            key={idx}
                                            idx={idx}
                                            label={labels[idx] ?? ""}
                                            body={msgs[idx] ?? ""}
                                            media={medias[idx] ?? []}
                                            uploading={uploadingSlot === idx}
                                            onLabel={(v) => onLabel(idx, v)}
                                            onBody={(v) => onBody(idx, v)}
                                            onPaste={onPaste(idx)}
                                            onDrop={onDrop(idx)}
                                            onPickFile={onPickFile(idx)}
                                            onRemoveMedia={(m) => onRemoveMedia(idx, m)}
                                        />
                                    );
                                })}
                            </div>
                        </section>
                    ))}
                </div>
            </div>

            <div className="panel flex flex-wrap items-center gap-4 px-5 py-4">
                <div className="flex-1 min-w-[280px]">
                    <div className="text-[14px] font-bold">
                        {page.isActive ? "Chiến dịch đang chạy" : "Bật chiến dịch"}
                    </div>
                    <p className="mt-0.5 text-[13px]" style={{ color: "var(--ink-2)" }}>
                        {page.isActive
                            ? `Engine đang gửi tự động cho ${num(page.activeCustomers)} khách theo 4 khung giờ mỗi ngày.`
                            : filled === 0
                              ? "Cần nhập nội dung và lưu kịch bản trước khi bật."
                              : `Bật lên là engine bắt đầu gửi thật cho ${num(page.activeCustomers)} khách. Ba ngày đầu chỉ gửi 25% tệp.`}
                    </p>
                </div>
                <button
                    className={page.isActive ? "btn btn-danger" : "btn btn-primary"}
                    onClick={onToggleActive}
                    disabled={!page.isActive && !schedule?.hasScript}
                >
                    {page.isActive ? "Tắt chiến dịch" : "Bật chiến dịch"}
                </button>
            </div>
        </div>
    );
}

// ═══ MÀN HÌNH 3 · BẮN TAY ═════════════════════════════════════════════════════

function ManualScreen({
    page,
    customers,
    loading,
    selected,
    onToggle,
    onToggleAll,
    body,
    media,
    uploading,
    sending,
    progress,
    onBody,
    onPaste,
    onDrop,
    onPickFile,
    onRemoveMedia,
    onSend,
    onReload,
}: {
    page: PageInfo;
    customers: Customer[];
    loading: boolean;
    selected: Set<string>;
    onToggle: (id: string) => void;
    onToggleAll: () => void;
    body: string;
    media: string[];
    uploading: boolean;
    sending: boolean;
    progress: { done: number; total: number } | null;
    onBody: (v: string) => void;
    onPaste: (e: React.ClipboardEvent) => void;
    onDrop: (e: React.DragEvent) => void;
    onPickFile: (e: React.ChangeEvent<HTMLInputElement>) => void;
    onRemoveMedia: (i: number) => void;
    onSend: () => void;
    onReload: () => void;
}) {
    const [q, setQ] = useState("");
    const [shown, setShown] = useState(100);

    const filtered = useMemo(() => {
        const t = q.trim().toLowerCase();
        if (!t) return customers;
        return customers.filter(
            (c) =>
                c.customerName.toLowerCase().includes(t) ||
                c.customerPhone.includes(t) ||
                c.psid.includes(t)
        );
    }, [customers, q]);

    const allShown = filtered.slice(0, shown);
    const canSend = selected.size > 0 && (body.trim() || media.length > 0) && !sending;

    return (
        <div className="grid gap-5 xl:grid-cols-[1fr_400px]">
            {/* Danh sách khách */}
            <div className="panel overflow-hidden">
                <div
                    className="flex flex-wrap items-center gap-2.5 border-b px-4 py-3"
                    style={{ borderColor: "var(--line)" }}
                >
                    <input
                        className="field max-w-[260px] flex-1 !py-1.5 !text-[13px]"
                        placeholder="Tìm theo tên, số điện thoại, PSID…"
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                    />
                    <button className="btn btn-ghost btn-sm" onClick={onReload}>
                        Tải lại
                    </button>
                    <div className="ml-auto flex items-center gap-2 text-[12.5px]" style={{ color: "var(--ink-3)" }}>
                        <span className="num">
                            <b style={{ color: "var(--brand)" }}>{num(selected.size)}</b> đã chọn
                        </span>
                        <span>/</span>
                        <span className="num">{num(filtered.length)} khách</span>
                    </div>
                </div>

                {loading ? (
                    <Empty title="Đang tải danh sách khách…" />
                ) : customers.length === 0 ? (
                    <Empty
                        title="Chưa có khách nào gửi được"
                        hint="Tệp khách được job đồng bộ đổ vào mỗi đêm. Chỉ khách tương tác trong 7 ngày gần nhất mới gửi được."
                    />
                ) : (
                    <>
                        <div className="max-h-[62vh] overflow-auto">
                            <table className="tbl">
                                <thead className="sticky top-0 z-10">
                                    <tr>
                                        <th className="w-10">
                                            <input
                                                type="checkbox"
                                                checked={selected.size > 0 && selected.size === filtered.length}
                                                onChange={onToggleAll}
                                                title="Chọn / bỏ chọn tất cả"
                                            />
                                        </th>
                                        <th>Khách hàng</th>
                                        <th>Số điện thoại</th>
                                        <th className="text-right">Ngày</th>
                                        <th>Tương tác cuối</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {allShown.map((c) => (
                                        <tr
                                            key={c.id}
                                            className="cursor-pointer"
                                            onClick={() => onToggle(c.id)}
                                            style={selected.has(c.id) ? { background: "var(--brand-soft)" } : undefined}
                                        >
                                            <td>
                                                <input
                                                    type="checkbox"
                                                    checked={selected.has(c.id)}
                                                    onChange={() => onToggle(c.id)}
                                                    onClick={(e) => e.stopPropagation()}
                                                />
                                            </td>
                                            <td>
                                                <div className="font-medium">{c.customerName}</div>
                                                <div className="mono" style={{ color: "var(--ink-3)" }}>
                                                    {c.psid}
                                                </div>
                                            </td>
                                            <td className="num" style={{ color: c.customerPhone ? "var(--ink-2)" : "var(--ink-3)" }}>
                                                {c.customerPhone || "—"}
                                            </td>
                                            <td className="num text-right">{c.journeyDay}</td>
                                            <td style={{ color: "var(--ink-3)" }}>{ago(c.lastInteraction)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        {filtered.length > shown && (
                            <div className="border-t px-4 py-2.5 text-center" style={{ borderColor: "var(--line-soft)" }}>
                                <button className="btn btn-ghost btn-sm" onClick={() => setShown((s) => s + 200)}>
                                    Hiện thêm ({num(filtered.length - shown)} khách nữa)
                                </button>
                            </div>
                        )}
                    </>
                )}
            </div>

            {/* Soạn tin */}
            <div className="panel flex h-fit flex-col p-4 xl:sticky xl:top-[124px]">
                <h2 className="text-[15px] font-bold">Gửi ngay một tin</h2>
                <p className="mt-0.5 text-[12.5px]" style={{ color: "var(--ink-3)" }}>
                    Tin này gửi một lần cho khách đang chọn, không ảnh hưởng chuỗi nuôi dưỡng.
                </p>

                <textarea
                    className="field mt-3 resize-y !text-[13.5px] leading-relaxed"
                    rows={7}
                    value={body}
                    onChange={(e) => onBody(e.target.value)}
                    onPaste={onPaste}
                    onDrop={onDrop}
                    onDragOver={(e) => e.preventDefault()}
                    placeholder={uploading ? "Đang tải ảnh lên…" : "Nhập nội dung… (dán ảnh thẳng vào đây cũng được)"}
                />

                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {media.map((url, i) => (
                        <span key={url + i} className="relative">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                                src={url}
                                alt=""
                                className="h-12 w-12 rounded-md border object-cover"
                                style={{ borderColor: "var(--line)" }}
                            />
                            <button
                                onClick={() => onRemoveMedia(i)}
                                className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold text-white"
                                style={{ background: "var(--bad)" }}
                            >
                                ×
                            </button>
                        </span>
                    ))}
                    <label
                        className="flex h-12 w-12 cursor-pointer items-center justify-center rounded-md border border-dashed text-[18px]"
                        style={{ borderColor: "var(--line)", color: "var(--ink-3)" }}
                    >
                        +
                        <input type="file" accept="image/*" multiple className="hidden" onChange={onPickFile} />
                    </label>
                </div>

                {!page.isActive && (
                    <div
                        className="mt-3 rounded-lg px-3 py-2.5 text-[12.5px]"
                        style={{ background: "var(--warn-soft)", color: "var(--warn)" }}
                    >
                        Page đang tắt — tin sẽ nằm trong hàng đợi và chỉ gửi khi anh/chị bật page.
                    </div>
                )}

                {progress && (
                    <div className="mt-3">
                        <div className="mb-1 flex justify-between text-[12px]" style={{ color: "var(--ink-2)" }}>
                            <span>Đang gửi…</span>
                            <span className="num">
                                {progress.done}/{progress.total}
                            </span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full" style={{ background: "var(--line)" }}>
                            <div
                                className="h-full rounded-full transition-all"
                                style={{
                                    background: "var(--brand)",
                                    width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%`,
                                }}
                            />
                        </div>
                    </div>
                )}

                <button className="btn btn-primary mt-3.5 w-full !py-2.5" onClick={onSend} disabled={!canSend}>
                    {sending
                        ? "Đang xếp hàng đợi…"
                        : selected.size === 0
                          ? "Chọn khách để gửi"
                          : `Gửi cho ${num(selected.size)} khách`}
                </button>
            </div>
        </div>
    );
}

// ═══ ỨNG DỤNG ═════════════════════════════════════════════════════════════════

export default function App() {
    const [screen, setScreen] = useState<Screen>("tong-quan");
    const [pages, setPages] = useState<PageInfo[]>([]);
    const [loadingPages, setLoadingPages] = useState(true);
    const [pageId, setPageId] = useState("");

    const [schedules, setSchedules] = useState<Schedule[]>([]);
    const [customers, setCustomers] = useState<Customer[]>([]);
    const [loadingCust, setLoadingCust] = useState(false);
    const [selected, setSelected] = useState<Set<string>>(new Set());

    const [msgs, setMsgs] = useState<string[]>(() => Array(SLOT_COUNT).fill(""));
    const [labels, setLabels] = useState<string[]>(() => Array(SLOT_COUNT).fill(""));
    const [medias, setMedias] = useState<string[][]>(() => Array.from({ length: SLOT_COUNT }, () => []));
    const [uploadingSlot, setUploadingSlot] = useState<number | null>(null);
    const [saving, setSaving] = useState(false);

    const [manualBody, setManualBody] = useState("");
    const [manualMedia, setManualMedia] = useState<string[]>([]);
    const [manualUploading, setManualUploading] = useState(false);
    const [sending, setSending] = useState(false);
    const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

    const [toast, setToast] = useState<{ text: string; kind: "ok" | "bad" } | null>(null);
    const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const say = useCallback((text: string, kind: "ok" | "bad" = "ok", ms = 5000) => {
        if (toastTimer.current) clearTimeout(toastTimer.current);
        setToast({ text, kind });
        toastTimer.current = setTimeout(() => setToast(null), ms);
    }, []);

    const page = useMemo(() => pages.find((p) => p.pageId === pageId) ?? null, [pages, pageId]);
    const schedule = useMemo(() => schedules.find((s) => s.pageId === pageId) ?? null, [schedules, pageId]);

    // ─── Tải dữ liệu ──────────────────────────────────────────────────────
    const loadPages = useCallback(async () => {
        setLoadingPages(true);
        try {
            const [pr, sr] = await Promise.all([
                apiFetch("/api/broadcast?getPages=true"),
                apiFetch("/api/broadcast/schedule"),
            ]);
            const pd = await pr.json();
            const sd = await sr.json();
            if (pd.pages) setPages(pd.pages);
            if (sd.schedules) setSchedules(sd.schedules);
        } catch {
            say("Không tải được danh sách page", "bad");
        } finally {
            setLoadingPages(false);
        }
    }, [say]);

    useEffect(() => {
        void loadPages();
    }, [loadPages]);

    const loadCustomers = useCallback(
        async (pid: string) => {
            if (!pid) return;
            setLoadingCust(true);
            setSelected(new Set());
            try {
                const r = await apiFetch(`/api/broadcast?pageFilter=${encodeURIComponent(pid)}`);
                const d = await r.json();
                setCustomers(d.customers ?? []);
            } catch {
                say("Không tải được danh sách khách", "bad");
                setCustomers([]);
            } finally {
                setLoadingCust(false);
            }
        },
        [say]
    );

    // Đổ nội dung kịch bản vào ô soạn theo segIdx — KHÔNG theo vị trí mảng, vì
    // kịch bản chỉ chứa các ô có nội dung, đổ theo vị trí sẽ lệch khung giờ.
    useEffect(() => {
        const nm: string[] = Array(SLOT_COUNT).fill("");
        const nl: string[] = Array(SLOT_COUNT).fill("");
        const nd: string[][] = Array.from({ length: SLOT_COUNT }, () => []);
        for (const seg of schedule?.segments ?? []) {
            const i = seg.segIdx;
            if (i >= 0 && i < SLOT_COUNT) {
                nm[i] = seg.message ?? "";
                nl[i] = seg.label ?? "";
                nd[i] = seg.media ?? [];
            }
        }
        setMsgs(nm);
        setLabels(nl);
        setMedias(nd);
    }, [schedule]);

    useEffect(() => {
        if (pageId && screen === "ban-tay") void loadCustomers(pageId);
    }, [pageId, screen, loadCustomers]);

    // ─── Tải ảnh ──────────────────────────────────────────────────────────
    const upload = useCallback(
        async (files: File[]): Promise<string[]> => {
            const imgs = files.filter((f) => f.type.startsWith("image/"));
            if (imgs.length === 0) return [];
            const fd = new FormData();
            for (const f of imgs) fd.append("images", f);
            if (pageId) fd.append("pageId", pageId);
            const res = await apiFetch("/api/upload", { method: "POST", body: fd });
            const d = await res.json();
            if (!res.ok || !d.media) {
                say(d.error ?? "Tải ảnh lên thất bại", "bad");
                return [];
            }
            return (d.media as { url: string }[]).map((m) => m.url);
        },
        [pageId, say]
    );

    const addSlotMedia = useCallback(
        async (i: number, files: File[]) => {
            setUploadingSlot(i);
            const urls = await upload(files);
            if (urls.length) setMedias((prev) => prev.map((m, k) => (k === i ? [...m, ...urls] : m)));
            setUploadingSlot(null);
        },
        [upload]
    );

    const addManualMedia = useCallback(
        async (files: File[]) => {
            setManualUploading(true);
            const urls = await upload(files);
            if (urls.length) setManualMedia((prev) => [...prev, ...urls]);
            setManualUploading(false);
        },
        [upload]
    );

    // ─── Lưu kịch bản ─────────────────────────────────────────────────────
    const saveScript = useCallback(async () => {
        if (!pageId) return;
        setSaving(true);
        try {
            const segments = msgs.map((m, i) => ({
                segIdx: i,
                hour: SLOT_HOURS[i % SLOT_HOURS.length],
                label: labels[i] ?? "",
                message: m,
                media: medias[i] ?? [],
            }));
            const res = await apiFetch("/api/broadcast/schedule", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "save", schedule: { pageId, segments } }),
            });
            const d = await res.json();
            if (!res.ok) {
                say(d.error ?? "Lưu thất bại", "bad");
                return;
            }
            say(d.message ?? "Đã lưu");
            await loadPages();
        } catch {
            say("Lỗi kết nối khi lưu", "bad");
        } finally {
            setSaving(false);
        }
    }, [pageId, msgs, labels, medias, say, loadPages]);

    // ─── Bật / tắt page ───────────────────────────────────────────────────
    const toggleActive = useCallback(async () => {
        if (!page) return;
        const turningOn = !page.isActive;
        if (
            turningOn &&
            !confirm(
                `Bật chiến dịch cho "${page.name}"?\n\nEngine sẽ bắt đầu gửi tin thật cho ${num(
                    page.activeCustomers
                )} khách hàng.\nBa ngày đầu chỉ gửi 25% tệp.`
            )
        )
            return;

        const res = await apiFetch("/api/broadcast/schedule", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "toggle", scheduleId: page.pageId }),
        });
        const d = await res.json();
        if (!res.ok) {
            say(d.error ?? "Không đổi được trạng thái", "bad");
            return;
        }
        say(d.isActive ? "Đã BẬT chiến dịch — engine bắt đầu gửi" : "Đã tắt chiến dịch");
        await loadPages();
    }, [page, say, loadPages]);

    // ─── Bắn tay ──────────────────────────────────────────────────────────
    const sendManual = useCallback(async () => {
        if (!page || selected.size === 0) return;
        const psids = customers.filter((c) => selected.has(c.id)).map((c) => c.psid);
        if (!confirm(`Gửi cho ${psids.length} khách?\n\nTin vào hàng đợi và được gửi trong vòng 1 phút.`)) return;

        setSending(true);
        const since = new Date().toISOString();
        try {
            const res = await apiFetch("/api/send", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ pageId, psids, message: manualBody, media: manualMedia }),
            });
            const d = await res.json();
            if (!res.ok) {
                say(d.error ?? "Không xếp được hàng đợi", "bad", 8000);
                return;
            }
            say(d.message, "ok", 8000);

            const deadline = Date.now() + 10 * 60_000;
            const poll = async () => {
                if (Date.now() > deadline) return setProgress(null);
                try {
                    const r = await apiFetch(
                        `/api/send?pageId=${encodeURIComponent(pageId)}&since=${encodeURIComponent(since)}`
                    );
                    const p = await r.json();
                    setProgress({ done: p.done ?? 0, total: p.total ?? 0 });
                    if ((p.queued ?? 0) + (p.sending ?? 0) > 0) setTimeout(poll, 3000);
                    else {
                        say(`Xong: ${p.sent} gửi được${p.failed ? ` · ${p.failed} lỗi` : ""}`, "ok", 9000);
                        setTimeout(() => setProgress(null), 4000);
                    }
                } catch {
                    setProgress(null);
                }
            };
            void poll();
        } finally {
            setSending(false);
        }
    }, [page, pageId, selected, customers, manualBody, manualMedia, say]);

    const goto = useCallback((pid: string, s: Screen) => {
        setPageId(pid);
        setScreen(s);
    }, []);

    const NAV: Array<{ key: Screen; label: string; needsPage: boolean }> = [
        { key: "tong-quan", label: "Tổng quan", needsPage: false },
        { key: "kich-ban", label: "Kịch bản tự động", needsPage: true },
        { key: "ban-tay", label: "Bắn tay", needsPage: true },
    ];

    return (
        <div className="min-h-screen">
            {/* ─── Thanh trên cùng ─────────────────────────────────────── */}
            <header
                className="sticky top-0 z-30 border-b"
                style={{ background: "var(--card)", borderColor: "var(--line)" }}
            >
                <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-x-6 gap-y-2 px-5 py-2.5">
                    <div className="flex items-center gap-2">
                        <span
                            className="flex h-7 w-7 items-center justify-center rounded-lg text-[13px] font-bold"
                            style={{ background: "var(--brand)", color: "var(--brand-ink)" }}
                        >
                            B
                        </span>
                        <span className="text-[14.5px] font-bold tracking-tight">Bắn bot TALPHA</span>
                    </div>

                    <nav className="flex gap-1">
                        {NAV.map((n) => {
                            const disabled = n.needsPage && !pageId;
                            const on = screen === n.key;
                            return (
                                <button
                                    key={n.key}
                                    disabled={disabled}
                                    onClick={() => setScreen(n.key)}
                                    title={disabled ? "Chọn một page trước" : undefined}
                                    className="rounded-lg px-3 py-1.5 text-[13.5px] font-semibold disabled:opacity-40"
                                    style={
                                        on
                                            ? { background: "var(--brand-soft)", color: "var(--brand)" }
                                            : { color: "var(--ink-2)" }
                                    }
                                >
                                    {n.label}
                                </button>
                            );
                        })}
                    </nav>

                    <div className="ml-auto flex items-center gap-2.5">
                        <select
                            className="field max-w-[280px] !w-auto !py-1.5 !text-[13px]"
                            value={pageId}
                            onChange={(e) => setPageId(e.target.value)}
                        >
                            <option value="">— Chọn page —</option>
                            {pages.map((p) => (
                                <option key={p.pageId} value={p.pageId}>
                                    {p.name} ({num(p.activeCustomers)})
                                </option>
                            ))}
                        </select>
                        {page && <PageStateChip p={page} />}
                    </div>
                </div>

                {/* Thanh ngữ cảnh: luôn thấy đang làm việc với page nào */}
                {page && (
                    <div
                        className="border-t px-5 py-2"
                        style={{ background: "var(--card-2)", borderColor: "var(--line-soft)" }}
                    >
                        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-x-5 gap-y-1 text-[12.5px]">
                            <span className="font-semibold">{page.name}</span>
                            <span style={{ color: "var(--ink-3)" }}>{page.shopName}</span>
                            <span className="num" style={{ color: "var(--ink-2)" }}>
                                <b>{num(page.activeCustomers)}</b> khách gửi được
                                <span style={{ color: "var(--ink-3)" }}> / {num(page.totalCustomers)} trong tệp</span>
                            </span>
                            {!page.hasScript && <Chip kind="warn">chưa có kịch bản</Chip>}
                            {page.isActive && page.rampPercent < 100 && (
                                <Chip kind="warn">khởi động dần {page.rampPercent}%</Chip>
                            )}
                            <span className="ml-auto" style={{ color: "var(--ink-3)" }}>
                                đồng bộ {ago(page.lastSyncedAt ?? "")}
                            </span>
                        </div>
                    </div>
                )}
            </header>

            <main className="mx-auto max-w-[1440px] px-5 py-5">
                {screen === "tong-quan" && (
                    <OverviewScreen pages={pages} loading={loadingPages} onPick={goto} />
                )}

                {screen !== "tong-quan" && !page && (
                    <div className="panel">
                        <Empty
                            title="Chưa chọn page"
                            hint="Chọn một page ở góc trên bên phải, hoặc quay lại Tổng quan để xem danh sách."
                            action={
                                <button className="btn btn-primary" onClick={() => setScreen("tong-quan")}>
                                    Về Tổng quan
                                </button>
                            }
                        />
                    </div>
                )}

                {screen === "kich-ban" && page && (
                    <ScriptScreen
                        page={page}
                        schedule={schedule}
                        msgs={msgs}
                        medias={medias}
                        labels={labels}
                        uploadingSlot={uploadingSlot}
                        saving={saving}
                        onLabel={(i, v) => setLabels((p) => p.map((x, k) => (k === i ? v : x)))}
                        onBody={(i, v) => setMsgs((p) => p.map((x, k) => (k === i ? v : x)))}
                        onPaste={(i) => (e) => {
                            const f = Array.from(e.clipboardData?.files ?? []);
                            if (f.length) {
                                e.preventDefault();
                                void addSlotMedia(i, f);
                            }
                        }}
                        onDrop={(i) => (e) => {
                            const f = Array.from(e.dataTransfer?.files ?? []);
                            if (f.length) {
                                e.preventDefault();
                                void addSlotMedia(i, f);
                            }
                        }}
                        onPickFile={(i) => (e) => {
                            const f = Array.from(e.target.files ?? []);
                            if (f.length) void addSlotMedia(i, f);
                            e.target.value = "";
                        }}
                        onRemoveMedia={(i, m) =>
                            setMedias((p) => p.map((x, k) => (k === i ? x.filter((_, j) => j !== m) : x)))
                        }
                        onSave={saveScript}
                        onToggleActive={toggleActive}
                    />
                )}

                {screen === "ban-tay" && page && (
                    <ManualScreen
                        page={page}
                        customers={customers}
                        loading={loadingCust}
                        selected={selected}
                        onToggle={(id) =>
                            setSelected((prev) => {
                                const n = new Set(prev);
                                if (n.has(id)) n.delete(id);
                                else n.add(id);
                                return n;
                            })
                        }
                        onToggleAll={() =>
                            setSelected((prev) =>
                                prev.size === customers.length ? new Set() : new Set(customers.map((c) => c.id))
                            )
                        }
                        body={manualBody}
                        media={manualMedia}
                        uploading={manualUploading}
                        sending={sending}
                        progress={progress}
                        onBody={setManualBody}
                        onPaste={(e) => {
                            const f = Array.from(e.clipboardData?.files ?? []);
                            if (f.length) {
                                e.preventDefault();
                                void addManualMedia(f);
                            }
                        }}
                        onDrop={(e) => {
                            const f = Array.from(e.dataTransfer?.files ?? []);
                            if (f.length) {
                                e.preventDefault();
                                void addManualMedia(f);
                            }
                        }}
                        onPickFile={(e) => {
                            const f = Array.from(e.target.files ?? []);
                            if (f.length) void addManualMedia(f);
                            e.target.value = "";
                        }}
                        onRemoveMedia={(i) => setManualMedia((p) => p.filter((_, k) => k !== i))}
                        onSend={sendManual}
                        onReload={() => void loadCustomers(pageId)}
                    />
                )}
            </main>

            {toast && (
                <div
                    className="panel fixed bottom-5 left-1/2 z-50 max-w-[92vw] -translate-x-1/2 px-4 py-2.5 text-[13.5px] font-medium"
                    style={{
                        background: toast.kind === "bad" ? "var(--bad-soft)" : "var(--ok-soft)",
                        color: toast.kind === "bad" ? "var(--bad)" : "var(--ok)",
                        borderColor: "transparent",
                    }}
                >
                    {toast.text}
                </div>
            )}
        </div>
    );
}
