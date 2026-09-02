/**
 * Dựng HTML bằng tay — không framework, không bước build, không CDN.
 *
 * Lý do: dashboard chạy trên VPS có thể bị chặn ra ngoài, và cả dự án vốn là
 * vài job Node + pg. Thêm React/Next chỉ để hiện mấy cái bảng là không xứng.
 * Toàn bộ CSS nhúng thẳng, tự chạy được cả khi mất mạng.
 */

/** Chặn XSS. Tên khách lấy từ Facebook nên PHẢI escape mọi nơi. */
export function esc(v: unknown): string {
    if (v === null || v === undefined) return "";
    return String(v)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

export function num(n: number | null | undefined): string {
    return (n ?? 0).toLocaleString("vi-VN");
}

export function pct(n: number): string {
    return `${(n * 100).toFixed(n < 0.1 ? 1 : 0)}%`;
}

/** Thời gian tương đối, đọc nhanh hơn timestamp đầy đủ. */
export function ago(d: Date | null | undefined): string {
    if (!d) return "—";
    const s = Math.round((Date.now() - d.getTime()) / 1000);
    if (s < 0) return `sau ${ago(new Date(Date.now() - (Date.now() - d.getTime()) * -1))}`;
    if (s < 60) return `${s}s trước`;
    if (s < 3600) return `${Math.round(s / 60)} phút trước`;
    if (s < 86400) return `${Math.round(s / 3600)} giờ trước`;
    return `${Math.round(s / 86400)} ngày trước`;
}

export function dt(d: Date | null | undefined): string {
    if (!d) return "—";
    return d.toISOString().slice(0, 16).replace("T", " ") + "Z";
}

/** Giờ theo múi giờ của page — dashboard hay phải đọc "lúc đó là mấy giờ bên đó". */
export function dtLocal(d: Date | null | undefined, utcOffset: number): string {
    if (!d) return "—";
    return new Date(d.getTime() + utcOffset * 3_600_000).toISOString().slice(5, 16).replace("T", " ");
}

export function truncate(s: string, n: number): string {
    const clean = s.replace(/\s+/g, " ").trim();
    return clean.length <= n ? clean : clean.slice(0, n - 1) + "…";
}

// ─── Thành phần ───────────────────────────────────────────────────────────────

export type Tone = "ok" | "warn" | "bad" | "muted" | "accent";

export function badge(text: string, tone: Tone = "muted"): string {
    return `<span class="badge ${tone}">${esc(text)}</span>`;
}

export function healthBadge(state: string, pausedUntil?: Date | null): string {
    if (state === "ok") return badge("chạy", "ok");
    if (state === "degraded") return badge("hãm tốc", "warn");
    const until = pausedUntil ? ` tới ${dt(pausedUntil).slice(5, 16)}` : "";
    return badge(`ngưng${until}`, "bad");
}

export function statusBadge(status: string): string {
    const map: Record<string, Tone> = { active: "accent", converted: "ok", opted_out: "bad", expired: "muted" };
    const label: Record<string, string> = {
        active: "đang nuôi", converted: "đã chốt", opted_out: "đã chặn", expired: "hết hạn",
    };
    return badge(label[status] ?? status, map[status] ?? "muted");
}

/** Thanh ngang so sánh — dùng cho phân bố ngày hành trình, hiệu quả tin. */
export function bar(value: number, max: number, tone: Tone = "accent"): string {
    const w = max > 0 ? Math.max(value > 0 ? 2 : 0, Math.round((value / max) * 100)) : 0;
    return `<span class="bar"><span class="bar-fill ${tone}" style="width:${w}%"></span></span>`;
}

export interface Col<T> {
    head: string;
    /** Căn phải cho cột số */
    right?: boolean;
    cell: (row: T) => string;
}

export function table<T>(cols: Col<T>[], rows: T[], emptyText = "Chưa có dữ liệu"): string {
    if (rows.length === 0) return `<p class="empty">${esc(emptyText)}</p>`;
    const head = cols.map((c) => `<th${c.right ? ' class="r"' : ""}>${esc(c.head)}</th>`).join("");
    const body = rows
        .map((r) => `<tr>${cols.map((c) => `<td${c.right ? ' class="r"' : ""}>${c.cell(r)}</td>`).join("")}</tr>`)
        .join("");
    return `<div class="tw"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

export function stat(label: string, value: string, hint?: string, tone?: Tone): string {
    return `<div class="stat${tone ? " " + tone : ""}">
        <div class="stat-v">${value}</div>
        <div class="stat-l">${esc(label)}</div>
        ${hint ? `<div class="stat-h">${esc(hint)}</div>` : ""}
    </div>`;
}

export function card(title: string, body: string, note?: string): string {
    return `<section class="card">
        <h2>${esc(title)}</h2>
        ${note ? `<p class="note">${esc(note)}</p>` : ""}
        ${body}
    </section>`;
}

// ─── Khung trang ──────────────────────────────────────────────────────────────

const CSS = `
:root{--bg:#eef0f4;--card:#fff;--card2:#f7f8fb;--ink:#171b23;--ink2:#4d566b;--ink3:#7c869c;
--line:#d7dce5;--line2:#e6eaf1;--accent:#0f5f6b;--accent-bg:#dbeef1;--gold:#9a6606;--gold-bg:#f7e9cd;
--ok:#17714a;--ok-bg:#d9efe4;--bad:#a5382a;--bad-bg:#f7dfda;
--d1:#bd6249;--d2:#b3860a;--d3:#7c519b;--d4:#3b559c}
@media(prefers-color-scheme:dark){:root{--bg:#0e1116;--card:#161b23;--card2:#1b212b;--ink:#e7eaf0;
--ink2:#a5aec1;--ink3:#79839a;--line:#29313e;--line2:#212832;--accent:#5cccd9;--accent-bg:#10333a;
--gold:#e2ad55;--gold-bg:#33280f;--ok:#55c592;--ok-bg:#12301f;--bad:#f08471;--bad-bg:#351812;
--d1:#e0917a;--d2:#e0b04a;--d3:#b98fd4;--d4:#7f9ae0}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 "Be Vietnam Pro",system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
header{background:var(--card);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:9}
header .in{max-width:1240px;margin:0 auto;padding:0 20px;display:flex;align-items:center;gap:22px;height:54px;flex-wrap:wrap}
header .brand{font-weight:700;font-size:15px;letter-spacing:-.01em;white-space:nowrap}
header nav{display:flex;gap:16px;font-size:14px}
header nav a{color:var(--ink2)}header nav a.on{color:var(--accent);font-weight:600}
header form{margin-left:auto}
header input{background:var(--card2);border:1px solid var(--line);border-radius:7px;padding:6px 11px;
font:inherit;font-size:13px;color:var(--ink);width:220px}
main{max-width:1240px;margin:0 auto;padding:24px 20px 72px}
h1{font-size:23px;font-weight:700;margin:0 0 4px;letter-spacing:-.015em}
h1 .sub{font-size:14px;font-weight:400;color:var(--ink3);margin-left:10px}
h2{font-size:15px;font-weight:700;margin:0 0 12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:11px;padding:18px 20px;margin:16px 0;
box-shadow:0 1px 2px rgba(0,0,0,.04)}
.note{color:var(--ink3);font-size:13px;margin:-6px 0 14px}
.empty{color:var(--ink3);font-size:14px;margin:6px 0;font-style:italic}
.stats{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));margin:16px 0}
.stat{background:var(--card);border:1px solid var(--line);border-radius:11px;padding:14px 16px}
.stat-v{font-size:26px;font-weight:700;line-height:1.15;font-variant-numeric:tabular-nums}
.stat-l{font-size:13px;color:var(--ink2);margin-top:2px}
.stat-h{font-size:12px;color:var(--ink3);margin-top:3px}
.stat.ok .stat-v{color:var(--ok)}.stat.bad .stat-v{color:var(--bad)}
.stat.warn .stat-v{color:var(--gold)}.stat.accent .stat-v{color:var(--accent)}
.tw{overflow-x:auto;margin:0 -4px}
table{border-collapse:collapse;width:100%;font-size:13.5px}
th,td{text-align:left;padding:8px 11px;border-bottom:1px solid var(--line2);vertical-align:top}
/* KHÔNG dùng position:sticky cho th: .tw có overflow-x:auto nên overflow-y tự
   thành auto, biến .tw thành vùng cuộn riêng — sticky sẽ bám vào .tw thay vì
   viewport và top:54px đẩy header xuống DƯỚI hàng đầu tiên. */
th{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink3);font-weight:600;
background:var(--card2);white-space:nowrap}
td.r,th.r{text-align:right;font-variant-numeric:tabular-nums}
tbody tr:last-child td{border-bottom:none}
tbody tr:hover{background:var(--card2)}
.badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11.5px;font-weight:600;white-space:nowrap}
.badge.ok{background:var(--ok-bg);color:var(--ok)}
.badge.bad{background:var(--bad-bg);color:var(--bad)}
.badge.warn{background:var(--gold-bg);color:var(--gold)}
.badge.accent{background:var(--accent-bg);color:var(--accent)}
.badge.muted{background:var(--card2);color:var(--ink3);border:1px solid var(--line)}
.bar{display:inline-block;width:110px;height:8px;background:var(--line2);border-radius:4px;overflow:hidden;vertical-align:middle}
.bar-fill{display:block;height:100%;border-radius:4px}
.bar-fill.accent{background:var(--accent)}.bar-fill.ok{background:var(--ok)}
.bar-fill.warn{background:var(--gold)}.bar-fill.bad{background:var(--bad)}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
code{background:var(--card2);border:1px solid var(--line2);border-radius:4px;padding:1px 5px}
.slot0{color:var(--d1)}.slot1{color:var(--d2)}.slot2{color:var(--d3)}.slot3{color:var(--d4)}
.msg{white-space:pre-wrap;background:var(--card2);border:1px solid var(--line2);border-radius:7px;
padding:9px 12px;font-size:13px;margin:5px 0 0;max-width:640px}
.rot td{text-align:center;font-variant-numeric:tabular-nums;font-weight:600}
.rot td.d{text-align:right;font-weight:500;color:var(--ink2);white-space:nowrap}
.rot td.lap{background:var(--gold-bg)}
.crumb{font-size:13px;color:var(--ink3);margin:0 0 10px}
.err{color:var(--bad);font-size:12.5px}
.warnbox{background:var(--gold-bg);border-left:3px solid var(--gold);border-radius:6px;padding:11px 15px;
margin:14px 0;font-size:14px;color:var(--ink2)}
@media(max-width:640px){header .in{height:auto;padding:10px 16px}header form{margin-left:0;width:100%}
header input{width:100%}main{padding:16px 16px 60px}}
`;

export function layout(title: string, nav: string, body: string): string {
    return `<!doctype html><html lang="vi"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)} · Bắn bot TALPHA</title><style>${CSS}</style></head><body>
<header><div class="in">
  <span class="brand">📡 Bắn bot TALPHA</span>
  <nav>
    <a href="/"${nav === "home" ? ' class="on"' : ""}>Tổng quan</a>
    <a href="/report"${nav === "report" ? ' class="on"' : ""}>Hiệu quả</a>
    <a href="/jobs"${nav === "jobs" ? ' class="on"' : ""}>Nhật ký job</a>
  </nav>
  <form action="/search"><input name="q" placeholder="Tìm khách: tên · SĐT · PSID" value=""></form>
</div></header>
<main>${body}</main></body></html>`;
}
