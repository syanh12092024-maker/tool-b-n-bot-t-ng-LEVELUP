import { config } from "../config/index.js";
import { messageIndexFor } from "../domain/journey.js";
import { suggestSlots, type ChatReport } from "../domain/chat-analysis.js";
import * as R from "../db/repositories/report.repo.js";
import * as scriptsRepo from "../db/repositories/scripts.repo.js";
import {
    esc, num, pct, ago, dt, dtLocal, truncate, badge, healthBadge, statusBadge,
    bar, table, stat, card, layout, type Col,
} from "./html.js";

/** Các trang của dashboard. Mỗi hàm trả về HTML hoàn chỉnh. */

const SLOT_NAMES = ["🌅 sáng", "☀️ trưa", "🌆 chiều", "🌙 tối"];

const LANG_LABEL: Record<string, string> = {
    ar: "Ả Rập", ja: "Nhật", zh: "Trung", ko: "Hàn", th: "Thái",
    vi: "Việt", latin: "Anh", unknown: "không rõ",
};

function slotLabel(i: number | null): string {
    if (i === null || i < 0) return "—";
    return `<span class="slot${i}">${esc(SLOT_NAMES[i] ?? `khung ${i}`)}</span>`;
}

function tz(offset: number): string {
    return `UTC${offset >= 0 ? "+" : ""}${offset}`;
}

// ═══ Tổng quan ════════════════════════════════════════════════════════════════

export async function home(): Promise<string> {
    const [pages, t] = await Promise.all([R.overview(), R.totals()]);

    const errRate = t.sent_24h + t.failed_24h > 0 ? t.failed_24h / (t.sent_24h + t.failed_24h) : 0;
    const stats = `<div class="stats">
        ${stat("Page đang chạy", num(t.pages_active))}
        ${stat("Khách đang nuôi", num(t.customers_active), "trong hành trình", "accent")}
        ${stat("Lượt đang chờ", num(t.queued_now), "trong hàng đợi")}
        ${stat("Đã gửi 24h", num(t.sent_24h), undefined, "ok")}
        ${stat("Lỗi 24h", num(t.failed_24h), errRate > 0 ? `tỉ lệ ${pct(errRate)}` : undefined, errRate > 0.3 ? "bad" : undefined)}
        ${stat("Chốt đơn 24h", num(t.converted_24h), "đã dừng chuỗi", "ok")}
    </div>`;

    const warnings: string[] = [];
    for (const p of pages) {
        if (!p.is_active) continue;
        if (!p.has_script) warnings.push(`<b>${esc(p.page_name)}</b> đang bật nhưng chưa có kịch bản — không gửi được gì.`);
        if (p.health_state === "paused") warnings.push(`<b>${esc(p.page_name)}</b> đang bị ngưng: ${esc(p.pause_reason ?? "")}`);
        if (!p.last_synced_at) warnings.push(`<b>${esc(p.page_name)}</b> chưa đồng bộ tệp khách lần nào — chạy <code>npm run job:sync -- --page ${esc(p.page_id)}</code>`);
        else if (Date.now() - p.last_synced_at.getTime() > 36 * 3600_000) {
            warnings.push(`<b>${esc(p.page_name)}</b> đồng bộ lần cuối ${esc(ago(p.last_synced_at))} — job sync có đang chạy không?`);
        }
    }
    const warnBox = warnings.length ? `<div class="warnbox">${warnings.map((w) => `⚠️ ${w}`).join("<br>")}</div>` : "";

    const cols: Col<R.PageOverview>[] = [
        { head: "Page", cell: (p) => `<a href="/page/${p.id}">${esc(p.page_name)}</a><br><span class="mono" style="color:var(--ink3)">${esc(p.page_id)}</span>` },
        { head: "Thị trường", cell: (p) => `${esc(p.market)}<br><span class="mono" style="color:var(--ink3)">${esc(tz(p.utc_offset))}</span>` },
        { head: "Trạng thái", cell: (p) => (p.is_active ? healthBadge(p.health_state, p.paused_until) : badge("tắt", "muted")) + (p.ramp_percent < 100 ? ` ${badge(`${p.ramp_percent}%`, "warn")}` : "") },
        { head: "Đang nuôi", right: true, cell: (p) => `<b>${num(p.active)}</b>` },
        { head: "Đã chốt", right: true, cell: (p) => (p.converted > 0 ? `<span style="color:var(--ok)">${num(p.converted)}</span>` : "—") },
        { head: "Chặn", right: true, cell: (p) => (p.opted_out > 0 ? num(p.opted_out) : "—") },
        { head: "Hết hạn", right: true, cell: (p) => num(p.expired) },
        { head: "Chờ hôm nay", right: true, cell: (p) => num(p.queued_today) },
        { head: "Gửi hôm nay", right: true, cell: (p) => `${num(p.sent_today)}${p.failed_today > 0 ? ` <span class="err">/${num(p.failed_today)} lỗi</span>` : ""}` },
        { head: "Đồng bộ", cell: (p) => `<span style="color:var(--ink3)">${esc(ago(p.last_synced_at))}</span>` },
    ];

    const body = `<h1>Tổng quan</h1>
        ${stats}${warnBox}
        ${card("Các page", table(cols, pages, "Chưa có page nào — thêm bằng npm run page:add"))}`;
    return layout("Tổng quan", "home", body);
}

// ═══ Chi tiết page ════════════════════════════════════════════════════════════

export async function pageDetail(id: number): Promise<string | null> {
    const page = await R.pageById(id);
    if (!page) return null;

    const [dist, queue, sends, health, errors, scriptData] = await Promise.all([
        R.journeyDistribution(id), R.queueBreakdown(id), R.recentSends(id, 40),
        R.healthHistory(id, 16), R.errorBreakdown(id, 24), R.activeScript(id),
    ]);

    const maxDay = Math.max(1, ...dist.map((d) => d.n));
    const distBody = table<{ journey_day: number; n: number }>(
        [
            { head: "Hành trình", cell: (d) => `Ngày ${d.journey_day}` },
            { head: "Khách", right: true, cell: (d) => `<b>${num(d.n)}</b>` },
            { head: "", cell: (d) => bar(d.n, maxDay) },
            { head: "Hôm nay nhận", cell: (d) => {
                if (!scriptData) return "—";
                const n = scriptData.messages.length;
                return config.journey.slotHours
                    .map((h, s) => `<span class="slot${s}">${messageIndexFor(d.journey_day, s, config.journey.slotsPerDay, n) + 1}</span>`)
                    .join(" · ");
            } },
        ],
        dist,
        "Chưa có khách nào đang trong hành trình"
    );

    const qMap = new Map(queue.map((q) => [q.state, q.n]));
    const qStats = `<div class="stats">
        ${stat("Đang chờ", num(qMap.get("queued") ?? 0), undefined, "accent")}
        ${stat("Đang gửi", num(qMap.get("sending") ?? 0))}
        ${stat("Đã gửi", num(qMap.get("sent") ?? 0), undefined, "ok")}
        ${stat("Thất bại", num(qMap.get("failed") ?? 0), undefined, (qMap.get("failed") ?? 0) > 0 ? "bad" : undefined)}
        ${stat("Bỏ qua", num(qMap.get("skipped") ?? 0), "quá giờ hoặc khách đã dừng")}
    </div>`;

    const sendCols: Col<(typeof sends)[number]>[] = [
        { head: "Lúc", cell: (s) => `<span class="mono">${esc(dtLocal(s.sent_at, page.utc_offset))}</span>` },
        { head: "Khách", cell: (s) => `<a href="/customer/${s.customer_id}">${esc(s.customer_name ?? s.psid)}</a>` },
        { head: "Ngày", right: true, cell: (s) => (s.journey_day ? String(s.journey_day) : "—") },
        { head: "Khung", cell: (s) => slotLabel(s.slot_index) },
        { head: "Tin", right: true, cell: (s) => (s.order_index !== null ? `#${s.order_index + 1}` : "—") },
        { head: "Kênh", cell: (s) => badge(s.channel === "pancake" ? "Pancake" : "Facebook", s.channel === "pancake" ? "accent" : "muted") + (s.fb_tag ? ` <span class="mono" style="color:var(--ink3)">${esc(s.fb_tag)}</span>` : "") },
        { head: "Kết quả", cell: (s) => s.success ? badge("ok", "ok") : `${badge(s.error_kind ?? "lỗi", "bad")}<br><span class="err">${esc(truncate(s.error_message ?? "", 70))}</span>` },
    ];

    const errCols: Col<(typeof errors)[number]>[] = [
        { head: "Loại lỗi", cell: (e) => badge(e.error_kind ?? "không rõ", "bad") },
        { head: "Số lần", right: true, cell: (e) => `<b>${num(e.n)}</b>` },
        { head: "Ví dụ", cell: (e) => `<span class="err">${esc(truncate(e.sample ?? "", 110))}</span>` },
    ];

    const healthCols: Col<(typeof health)[number]>[] = [
        { head: "Cửa sổ", cell: (h) => `<span class="mono">${esc(dtLocal(h.window_start, page.utc_offset))}</span>` },
        { head: "Gửi", right: true, cell: (h) => num(h.sent) },
        { head: "Lỗi", right: true, cell: (h) => (h.failed > 0 ? `<span class="err">${num(h.failed)}</span>` : "0") },
        { head: "#2022", right: true, cell: (h) => (h.error_2022 > 0 ? `<span class="err">${num(h.error_2022)}</span>` : "—") },
        { head: "121", right: true, cell: (h) => (h.error_121 > 0 ? `<span class="err">${num(h.error_121)}</span>` : "—") },
        { head: "Tỉ lệ lỗi", right: true, cell: (h) => pct(Number(h.error_rate)) },
        { head: "Hành động", cell: (h) => (h.action_taken ? badge(h.action_taken, h.action_taken === "recover" ? "ok" : "warn") : "—") },
    ];

    const scriptLink = scriptData
        ? `<a href="/page/${id}/script">${esc(scriptData.script.name)}</a> — ${scriptData.messages.length} nội dung`
        : `<span class="err">Chưa có kịch bản — page này không gửi được gì</span>`;
    const soanBtn = `<a href="/page/${id}/soan" style="display:inline-block;background:var(--accent);color:var(--card);border-radius:7px;padding:7px 16px;font-size:13px;font-weight:700;text-decoration:none;margin-left:10px">✍️ Soạn nội dung</a>`;

    const body = `<p class="crumb"><a href="/">Tổng quan</a> › ${esc(page.page_name)}</p>
        <h1>${esc(page.page_name)} <span class="sub">${esc(page.market)} · ${esc(tz(page.utc_offset))} · <span class="mono">${esc(page.page_id)}</span></span></h1>
        <p style="margin:6px 0 0">
            ${page.is_active ? healthBadge(page.health_state) : badge("tắt", "muted")}
            ${page.ramp_percent < 100 ? badge(`khởi động dần ${page.ramp_percent}%`, "warn") : ""}
            ${page.pancake_shop_id ? badge(`POS shop ${page.pancake_shop_id}`, "muted") : badge("chưa gắn shop POS", "muted")}
            &nbsp; Kịch bản: ${scriptLink}${soanBtn}
        </p>
        ${qStats}
        ${card("Phân bố hành trình", distBody, "Mỗi khách ở ngày thứ mấy, và hôm nay họ nhận tin số mấy")}
        ${errors.length ? card("Lỗi 24 giờ qua", table(errCols, errors)) : ""}
        ${card("Sức khoẻ page", table(healthCols, health, "Job health chưa chạy lần nào"), "Ảnh chụp mỗi 15 phút, giờ địa phương của page")}
        ${card("Gửi gần nhất", table(sendCols, sends, "Chưa gửi tin nào"))}`;

    return layout(page.page_name, "home", body);
}

// ═══ Kịch bản của page ════════════════════════════════════════════════════════

export async function scriptView(id: number): Promise<string | null> {
    const page = await R.pageById(id);
    if (!page) return null;
    const data = await R.activeScript(id);
    if (!data) {
        return layout(
            "Kịch bản",
            "home",
            `<p class="crumb"><a href="/">Tổng quan</a> › <a href="/page/${id}">${esc(page.page_name)}</a> › Kịch bản</p>
             <h1>Chưa có kịch bản</h1>
             <div class="warnbox">Page này chưa có kịch bản đang bật nên không gửi được gì.<br>
             Nạp bằng: <code>npm run script:seed -- --page ${esc(page.page_id)} --file kich-ban/&lt;file&gt;.json</code></div>`
        );
    }

    const { script, messages } = data;
    const n = messages.length;

    // Bảng xoay vòng: khách nhận tin số mấy vào ngày nào, khung nào
    const rows: string[] = [];
    for (let day = 1; day <= script.journey_days; day++) {
        const cells = config.journey.slotHours.slice(0, script.slots_per_day).map((h, s) => {
            const idx = messageIndexFor(day, s, script.slots_per_day, n);
            const isRepeat = (day - 1) * script.slots_per_day + s >= n;
            return `<td class="${isRepeat ? "lap" : ""}"><span class="slot${s}">${idx + 1}</span></td>`;
        });
        rows.push(`<tr><td class="d">Ngày ${day}</td>${cells.join("")}</tr>`);
    }
    const heads = config.journey.slotHours.slice(0, script.slots_per_day).map((h, s) => `<th class="r" style="text-align:center">${h}h ${esc(SLOT_NAMES[s] ?? "")}</th>`).join("");
    const rotation = `<div class="tw"><table class="rot"><thead><tr><th>Hành trình</th>${heads}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;

    const msgCols: Col<(typeof messages)[number]>[] = [
        { head: "#", right: true, cell: (m) => `<b>${m.order_index + 1}</b>` },
        { head: "Nhãn", cell: (m) => esc(m.label ?? "—") },
        { head: "Nội dung", cell: (m) => `<div class="msg">${esc(m.body)}</div>${m.media.length ? `<div style="margin-top:5px">${m.media.map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener">🖼 ảnh</a>`).join(" · ")}</div>` : ""}` },
    ];

    const body = `<p class="crumb"><a href="/">Tổng quan</a> › <a href="/page/${id}">${esc(page.page_name)}</a> › Kịch bản</p>
        <h1>${esc(script.name)} <span class="sub">${n} nội dung · ${script.journey_days} ngày × ${script.slots_per_day} khung</span></h1>
        ${card("Lịch một khách sẽ nhận", rotation, `Số trong ô là tin thứ mấy. Ô nền vàng là lần lặp lại — công thức ((ngày−1)×${script.slots_per_day}+khung) mod ${n}`)}
        ${card("Nội dung", table(msgCols, messages))}
        <p style="margin:18px 0">
            <a href="/page/${id}/script/edit"
               style="display:inline-block;background:var(--accent);color:var(--card);border-radius:8px;padding:11px 24px;font-weight:700;text-decoration:none">✏️ Sửa nội dung</a>
        </p>`;
    return layout(`Kịch bản · ${page.page_name}`, "home", body);
}

// ═══ Hiệu quả ═════════════════════════════════════════════════════════════════

export async function report(pageDbId?: number): Promise<string> {
    const pages = await R.overview();
    const target = pageDbId ?? pages.find((p) => p.is_active)?.id ?? pages[0]?.id;

    if (target === undefined) {
        return layout("Hiệu quả", "report", `<h1>Hiệu quả kịch bản</h1><p class="empty">Chưa có page nào.</p>`);
    }

    const [perf, byDay, page] = await Promise.all([
        R.messagePerformance(target), R.conversionByDay(target), R.pageById(target),
    ]);

    const picker = pages.length > 1
        ? `<p style="margin:0 0 16px">${pages.map((p) => p.id === target
            ? `<b>${esc(p.page_name)}</b>`
            : `<a href="/report?page=${p.id}">${esc(p.page_name)}</a>`).join(" · ")}</p>`
        : "";

    const maxConv = Math.max(1, ...perf.map((m) => m.conversions));
    const totalConv = perf.reduce((a, m) => a + m.conversions, 0);

    const perfCols: Col<R.MessagePerformance>[] = [
        { head: "#", right: true, cell: (m) => `<b>${m.order_index + 1}</b>` },
        { head: "Nhãn", cell: (m) => esc(m.label ?? "—") },
        { head: "Nội dung", cell: (m) => `<span style="color:var(--ink2)">${esc(truncate(m.body, 60))}</span>` },
        { head: "Đã gửi", right: true, cell: (m) => num(m.sent) },
        { head: "Lỗi", right: true, cell: (m) => (m.failed > 0 ? `<span class="err">${num(m.failed)}</span>` : "—") },
        { head: "Ra đơn", right: true, cell: (m) => (m.conversions > 0 ? `<b style="color:var(--ok)">${num(m.conversions)}</b>` : "—") },
        { head: "", cell: (m) => bar(m.conversions, maxConv, "ok") },
        { head: "Tỉ lệ", right: true, cell: (m) => (m.sent > 0 ? pct(m.conversions / m.sent) : "—") },
    ];

    const maxDayConv = Math.max(1, ...byDay.map((d) => d.n));
    const dayCols: Col<(typeof byDay)[number]>[] = [
        { head: "Chốt ở ngày", cell: (d) => (d.journey_day ? `Ngày ${d.journey_day}` : "không rõ") },
        { head: "Số khách", right: true, cell: (d) => `<b>${num(d.n)}</b>` },
        { head: "", cell: (d) => bar(d.n, maxDayConv, "ok") },
        { head: "Tỉ lệ", right: true, cell: (d) => (totalConv > 0 ? pct(d.n / byDay.reduce((a, x) => a + x.n, 0)) : "—") },
    ];

    const hint = totalConv === 0
        ? "Chưa có khách nào chốt đơn — bảng sẽ có số khi job POS hoặc webhook ghi nhận đơn đầu tiên."
        : `Quy công theo "chạm cuối": mỗi khách đã chốt được tính cho tin CUỐI CÙNG họ nhận trước lúc chốt. Tổng ${totalConv} đơn.`;

    const body = `<h1>Hiệu quả kịch bản${page ? ` <span class="sub">${esc(page.page_name)}</span>` : ""}</h1>
        ${picker}
        ${card("Tin nào ra đơn nhiều nhất", table(perfCols, perf, "Page này chưa có kịch bản đang bật"), hint)}
        ${card("Khách chốt ở ngày thứ mấy", table(dayCols, byDay, "Chưa có đơn nào"), "Giúp quyết định có nên rút ngắn hay kéo dài hành trình")}`;
    return layout("Hiệu quả", "report", body);
}

// ═══ Tra cứu khách ════════════════════════════════════════════════════════════

export async function search(q: string): Promise<string> {
    const rows = q.trim() ? await R.searchCustomers(q, undefined, 60) : [];
    const cols: Col<R.CustomerRow>[] = [
        { head: "Khách", cell: (c) => `<a href="/customer/${c.id}">${esc(c.name ?? "(không tên)")}</a><br><span class="mono" style="color:var(--ink3)">${esc(c.psid)}</span>` },
        { head: "Page", cell: (c) => `<a href="/page/${c.page_id}">${esc(c.page_name)}</a>` },
        { head: "SĐT", cell: (c) => esc(c.phone ?? "—") },
        { head: "Trạng thái", cell: (c) => statusBadge(c.status) + (c.stop_reason ? `<br><span style="color:var(--ink3);font-size:12px">${esc(truncate(c.stop_reason, 44))}</span>` : "") },
        { head: "Ngày", right: true, cell: (c) => String(c.journey_day) },
        { head: "Đã nhận", right: true, cell: (c) => num(c.sent_count) },
        { head: "Tương tác cuối", cell: (c) => `<span style="color:var(--ink3)">${esc(ago(c.last_interaction_at))}</span>` },
    ];

    const body = `<h1>Tra cứu khách</h1>
        <form action="/search" style="margin:14px 0">
            <input name="q" value="${esc(q)}" placeholder="Tên · số điện thoại · PSID"
                   style="background:var(--card);border:1px solid var(--line);border-radius:8px;padding:9px 13px;font:inherit;width:340px;max-width:100%;color:var(--ink)">
            <button style="background:var(--accent);color:var(--card);border:0;border-radius:8px;padding:10px 18px;font:inherit;font-weight:600;cursor:pointer">Tìm</button>
        </form>
        ${q.trim() ? card(`${rows.length} kết quả cho "${q.trim()}"`, table(cols, rows, "Không tìm thấy khách nào")) : `<p class="empty">Nhập tên, số điện thoại hoặc PSID để tra cứu.</p>`}`;
    return layout("Tra cứu", "", body);
}

export async function customerView(id: number): Promise<string | null> {
    const data = await R.customerDetail(id);
    if (!data) return null;
    const { customer: c, sends, events, upcoming } = data;

    const sendCols: Col<(typeof sends)[number]>[] = [
        { head: "Lúc", cell: (s) => `<span class="mono">${esc(dt(s.sent_at))}</span>` },
        { head: "Ngày", right: true, cell: (s) => (s.journey_day ? String(s.journey_day) : "—") },
        { head: "Khung", cell: (s) => slotLabel(s.slot_index) },
        { head: "Tin", cell: (s) => (s.order_index !== null ? `#${s.order_index + 1} ${esc(s.label ?? "")}` : "—") },
        { head: "Kênh", cell: (s) => badge(s.channel === "pancake" ? "Pancake" : "Facebook", s.channel === "pancake" ? "accent" : "muted") },
        { head: "Kết quả", cell: (s) => s.success ? badge("ok", "ok") : `${badge(s.error_kind ?? "lỗi", "bad")} <span class="err">${esc(truncate(s.error_message ?? "", 60))}</span>` },
        { head: "Nội dung", cell: (s) => `<span style="color:var(--ink3)">${esc(truncate(s.body ?? "", 50))}</span>` },
    ];

    const evLabel: Record<string, string> = {
        entered: "vào tệp", replied: "khách trả lời", ordered: "chốt đơn",
        opted_out: "từ chối nhận tin", expired: "hết hạn", restarted: "quay lại chuỗi",
    };
    const evCols: Col<(typeof events)[number]>[] = [
        { head: "Lúc", cell: (e) => `<span class="mono">${esc(dt(e.occurred_at))}</span>` },
        { head: "Sự kiện", cell: (e) => badge(evLabel[e.type] ?? e.type, e.type === "ordered" ? "ok" : e.type === "opted_out" ? "bad" : "muted") },
        { head: "Ngày", right: true, cell: (e) => (e.journey_day ? String(e.journey_day) : "—") },
        { head: "Chi tiết", cell: (e) => `<span style="color:var(--ink3)">${esc(truncate(JSON.stringify(e.payload), 80))}</span>` },
    ];

    const upCols: Col<(typeof upcoming)[number]>[] = [
        { head: "Sẽ gửi lúc", cell: (u) => `<span class="mono">${esc(dt(u.scheduled_at))}</span>` },
        { head: "Ngày", right: true, cell: (u) => String(u.journey_day) },
        { head: "Khung", cell: (u) => slotLabel(u.slot_index) },
        { head: "Tin", right: true, cell: (u) => (u.order_index !== null ? `#${u.order_index + 1}` : "—") },
    ];

    const body = `<p class="crumb"><a href="/">Tổng quan</a> › <a href="/page/${c.page_id}">${esc(c.page_name)}</a> › Khách</p>
        <h1>${esc(c.name ?? "(không tên)")} <span class="sub mono">${esc(c.psid)}</span></h1>
        <p style="margin:6px 0 0">${statusBadge(c.status)}
           ${c.stop_reason ? `<span style="color:var(--ink3);font-size:13px">— ${esc(c.stop_reason)}</span>` : ""}</p>
        <div class="stats">
            ${stat("Ngày hành trình", String(c.journey_day), c.journey_count > 1 ? `lần thứ ${c.journey_count} vào chuỗi` : undefined, "accent")}
            ${stat("Đã nhận", num(c.sent_count), "tin gửi thành công")}
            ${stat("Đơn trên POS", num(c.order_count), c.order_count_baseline !== null ? `mốc chuẩn: ${c.order_count_baseline}` : "chưa đối chiếu POS")}
            ${stat("Tương tác cuối", ago(c.last_interaction_at), dt(c.last_interaction_at))}
            ${stat("Vào tệp", ago(c.first_seen_at), dt(c.first_seen_at))}
            ${stat("SĐT", c.phone ? esc(c.phone) : "—")}
        </div>
        ${upcoming.length ? card("Sắp nhận", table(upCols, upcoming)) : ""}
        ${card("Đã nhận gì", table(sendCols, sends, "Chưa nhận tin nào"))}
        ${card("Sự kiện", table(evCols, events, "Chưa có sự kiện"))}`;
    return layout(c.name ?? c.psid, "", body);
}

// ═══ Nhật ký job ══════════════════════════════════════════════════════════════

export async function jobs(): Promise<string> {
    const runs = await R.recentJobRuns(40);
    const cols: Col<(typeof runs)[number]>[] = [
        { head: "Bắt đầu", cell: (r) => `<span class="mono">${esc(dt(r.started_at))}</span>` },
        { head: "Job", cell: (r) => badge(r.job, "accent") },
        { head: "Mất", right: true, cell: (r) => (r.finished_at ? `${Math.round((r.finished_at.getTime() - r.started_at.getTime()) / 1000)}s` : "đang chạy") },
        { head: "Kết quả", cell: (r) => (r.ok === null ? badge("đang chạy", "warn") : r.ok ? badge("ok", "ok") : badge("lỗi", "bad")) },
        { head: "Chi tiết", cell: (r) => r.error ? `<span class="err">${esc(truncate(r.error, 110))}</span>` : `<span class="mono" style="color:var(--ink3)">${esc(truncate(JSON.stringify(r.stats), 110))}</span>` },
    ];
    return layout("Nhật ký job", "jobs", `<h1>Nhật ký job</h1>
        ${card("40 lượt chạy gần nhất", table(cols, runs, "Chưa job nào chạy"), "sync · plan · send · pos · health")}`);
}

// ═══ Sửa kịch bản ═════════════════════════════════════════════════════════════

/**
 * Màn hình sửa 12 nội dung ngay trên web.
 *
 * Đây là màn hình DUY NHẤT ghi dữ liệu. Lý do phá lệ "dashboard chỉ đọc": bắt
 * người vận hành SSH vào server rồi sửa file JSON để đổi một câu chữ là không
 * dùng được. Việc này họ làm hằng tuần.
 *
 * An toàn: chỉ sửa được CHỮ và ẢNH của tin, không đụng được tới việc bật/tắt
 * page hay hàng đợi gửi — hai thứ đó vẫn phải qua CLI.
 */
export async function scriptEdit(id: number, opts: { saved?: boolean; error?: string } = {}): Promise<string | null> {
    const page = await R.pageById(id);
    if (!page) return null;
    const data = await R.activeScript(id);

    if (!data) {
        return layout("Sửa kịch bản", "home",
            `<p class="crumb"><a href="/">Tổng quan</a> › <a href="/page/${id}">${esc(page.page_name)}</a></p>
             <h1>Page này chưa có kịch bản</h1>
             <div class="warnbox">Cần nạp kịch bản lần đầu bằng dòng lệnh, sau đó mới sửa được trên web:<br>
             <code>bash kich-ban/capnhat.sh ${esc(page.page_id)} &lt;tên-file&gt;.json</code></div>`);
    }

    const { script, messages } = data;
    const n = messages.length;

    const banner = opts.error
        ? `<div class="warnbox" style="background:var(--bad-bg);border-left-color:var(--bad)">❌ ${esc(opts.error)}</div>`
        : opts.saved
          ? `<div class="warnbox" style="background:var(--ok-bg);border-left-color:var(--ok)">✅ Đã lưu. Các tin gửi từ giờ trở đi sẽ dùng nội dung mới.</div>`
          : "";

    const fields = messages.map((m) => {
        // Tin này rơi vào ngày nào, khung nào — giúp người sửa hình dung ngữ cảnh
        const when: string[] = [];
        for (let d = 1; d <= script.journey_days; d++) {
            for (let s = 0; s < script.slots_per_day; s++) {
                if (messageIndexFor(d, s, script.slots_per_day, n) === m.order_index) {
                    when.push(`ngày ${d} · ${config.journey.slotHours[s]}h`);
                }
            }
        }
        const chuaDien = /\[ĐIỀN|\[THAY/.test(m.body);
        return `<div class="card" style="margin:12px 0${chuaDien ? ";border-color:var(--gold)" : ""}">
            <div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:8px">
                <span style="font-family:ui-monospace,monospace;font-size:19px;font-weight:700;color:var(--accent)">${m.order_index + 1}</span>
                <input type="text" name="label_${m.order_index}" value="${esc(m.label ?? "")}"
                       placeholder="nhãn ghi nhớ, ví dụ: báo giá"
                       style="flex:1;min-width:170px;max-width:280px;background:var(--card2);border:1px solid var(--line);border-radius:6px;padding:5px 9px;font:inherit;font-size:13px;color:var(--ink)">
                <span style="font-size:12px;color:var(--ink3)">gửi vào: ${esc(when.join(" · "))}</span>
                ${chuaDien ? badge("chưa điền xong", "warn") : ""}
            </div>
            <textarea name="body_${m.order_index}" rows="4"
                      style="width:100%;background:var(--card2);border:1px solid var(--line);border-radius:7px;padding:10px 12px;font:inherit;font-size:14px;line-height:1.55;color:var(--ink);resize:vertical">${esc(m.body)}</textarea>
            <input type="text" name="media_${m.order_index}" value="${esc(m.media.join(", "))}"
                   placeholder="link ảnh, nhiều ảnh thì ngăn bằng dấu phẩy (để trống nếu không có)"
                   style="width:100%;margin-top:7px;background:var(--card2);border:1px solid var(--line);border-radius:6px;padding:6px 10px;font:inherit;font-size:12.5px;color:var(--ink2)">
        </div>`;
    }).join("");

    const body = `<p class="crumb"><a href="/">Tổng quan</a> › <a href="/page/${id}">${esc(page.page_name)}</a> › <a href="/page/${id}/script">Kịch bản</a> › Sửa</p>
        <h1>Sửa nội dung <span class="sub">${esc(page.page_name)} · ${n} tin</span></h1>
        ${banner}
        <p class="note">Sửa chữ trong ô rồi bấm <b>Lưu</b> ở cuối trang. Mỗi tin phải có chữ hoặc ảnh, không được để trống cả hai.</p>
        <form method="POST" action="/page/${id}/script">
            ${fields}
            <div style="position:sticky;bottom:0;background:var(--card);border:1px solid var(--line);border-radius:11px;padding:14px 18px;margin:18px 0;display:flex;gap:12px;align-items:center;box-shadow:0 -2px 12px rgba(0,0,0,.06)">
                <button type="submit" style="background:var(--accent);color:var(--card);border:0;border-radius:8px;padding:11px 26px;font:inherit;font-weight:700;cursor:pointer">Lưu nội dung</button>
                <a href="/page/${id}/script" style="color:var(--ink3)">Huỷ, quay lại</a>
                <span style="margin-left:auto;font-size:12.5px;color:var(--ink3)">Không đụng tới việc bật/tắt page</span>
            </div>
        </form>`;
    return layout(`Sửa · ${page.page_name}`, "home", body);
}

/** Nhận dữ liệu form gửi lên. Trả về lỗi dạng chữ nếu không lưu được. */
export async function scriptSave(id: number, form: URLSearchParams): Promise<string | null> {
    const data = await R.activeScript(id);
    if (!data) return "Page này chưa có kịch bản";

    const edits = data.messages.map((m) => ({
        orderIndex: m.order_index,
        body: form.get(`body_${m.order_index}`) ?? m.body,
        media: (form.get(`media_${m.order_index}`) ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        label: (form.get(`label_${m.order_index}`) ?? "").trim() || null,
    }));

    try {
        await scriptsRepo.updateMessageBodies(data.script.id, edits);
        return null;
    } catch (err) {
        return err instanceof Error ? err.message : String(err);
    }
}

// ═══ Khung soạn nội dung ══════════════════════════════════════════════════════

/**
 * Màn hình soạn 12 tin, có số liệu hội thoại thật của chính page đó nằm ngay cạnh.
 *
 * Vì sao không dùng lại màn hình Sửa: màn hình này phục vụ việc viết TỪ ĐẦU —
 * cần thấy khách hỏi gì, giá bao nhiêu, vướng ở đâu, và cần tạo được kịch bản
 * khi page chưa có. Màn hình Sửa chỉ để chỉnh chữ trên kịch bản đã chạy.
 */
export async function composeView(
    id: number,
    opts: { saved?: boolean; error?: string; created?: boolean } = {}
): Promise<string | null> {
    const page = await R.pageById(id);
    if (!page) return null;

    const [data, stored] = await Promise.all([R.activeScript(id), scriptsRepo.getAnalysis(id)]);
    const report = stored ? (stored.report as unknown as ChatReport) : null;

    const crumb = `<p class="crumb"><a href="/">Tổng quan</a> › <a href="/page/${id}">${esc(page.page_name)}</a> › Soạn nội dung</p>`;

    // ── Chưa phân tích ────────────────────────────────────────────────────
    if (!report) {
        return layout("Soạn nội dung", "home",
            `${crumb}<h1>Chưa có số liệu hội thoại</h1>
             <div class="warnbox">
               Khung soạn dựa trên chính hội thoại thật của page này. Chạy phân tích trước
               (mất vài phút, không tốn phí):<br><br>
               <code>npm run chat:phan-tich -- --page ${esc(page.page_id)} --so 100</code><br><br>
               Chạy xong tải lại trang này.
             </div>`);
    }

    const slots = suggestSlots(report, report.conversations ? 12 : 12);
    const messages = data?.messages ?? [];

    // ── Chưa có kịch bản → mời tạo khung rỗng ─────────────────────────────
    if (!data) {
        const preview = slots.map((s, i) =>
            `<tr><td class="r"><b>${i + 1}</b></td><td>${esc(s.label)}</td>
             <td style="color:var(--ink3);font-size:13px">${esc(s.hint)}</td></tr>`).join("");
        return layout("Soạn nội dung", "home",
            `${crumb}<h1>Tạo khung 12 tin cho ${esc(page.page_name)}</h1>
             <p class="note">Khung dưới đây dựng từ ${report.conversations ?? "?"} hội thoại thật của chính page này.
                Bấm tạo rồi nhập nội dung — mỗi page một nội dung riêng, không dùng chung.</p>
             <div class="tw"><table><thead><tr><th class="r">#</th><th>Ô</th><th>Ô này nên trả lời điều gì</th></tr></thead>
             <tbody>${preview}</tbody></table></div>
             <form method="POST" action="/page/${id}/soan/tao" style="margin:20px 0">
               <button type="submit" style="background:var(--accent);color:var(--card);border:0;border-radius:8px;padding:12px 26px;font:inherit;font-weight:700;cursor:pointer">Tạo khung 12 tin</button>
               <a href="/page/${id}" style="margin-left:14px;color:var(--ink3)">Quay lại</a>
             </form>`);
    }

    const banner = opts.error
        ? `<div class="warnbox" style="background:var(--bad-bg);border-left-color:var(--bad)">❌ ${esc(opts.error)}</div>`
        : opts.created
          ? `<div class="warnbox" style="background:var(--ok-bg);border-left-color:var(--ok)">✅ Đã tạo khung. Giờ nhập nội dung vào từng ô rồi bấm Lưu.</div>`
          : opts.saved
            ? `<div class="warnbox" style="background:var(--ok-bg);border-left-color:var(--ok)">✅ Đã lưu nội dung.</div>`
            : "";

    // ── Bảng số liệu tóm tắt, luôn hiện trên đầu ──────────────────────────
    const priceTop = report.prices?.[0];
    const facts = `<div class="stats">
        ${stat("Hội thoại đã đọc", num(report.conversations))}
        ${stat("Hỏi giá ngay câu đầu",
            report.withCustomerMessage ? pct(report.priceAskedFirstTurn / report.withCustomerMessage) : "—",
            "trả lời thẳng ở tin 1–2", "accent")}
        ${stat("Giá đang báo", priceTop ? `${priceTop.currency} ${priceTop.amount}` : "—",
            priceTop ? `${priceTop.count} lần` : "không tìm thấy", "ok")}
        ${stat("Để lại SĐT", pct(report.phoneRate ?? 0), "tỉ lệ hiện tại")}
        ${stat("Ngôn ngữ chính", report.langs?.[0] ? LANG_LABEL[report.langs[0].lang] ?? report.langs[0].lang : "—",
            report.langs?.[1] ? `kế tiếp: ${LANG_LABEL[report.langs[1].lang] ?? report.langs[1].lang} ${pct(report.langs[1].pct)}` : undefined)}
    </div>`;

    // Nhóm không có trích dẫn riêng (dẫn chứng đã hiện ở nhóm trên) thì bỏ hẳn
    // phần trích, không để lại cặp ngoặc kép rỗng
    const objList = (report.objections ?? []).slice(0, 6).map((o) => {
        const q = o.samples?.[0];
        return `<li><b>${esc(o.label)}</b> — ${o.count} hội thoại${
            q ? `<div style="color:var(--ink3);font-size:12.5px;margin-top:2px">“${esc(truncate(q, 110))}”</div>`
              : `<div style="color:var(--ink3);font-size:12.5px;margin-top:2px">cùng tin đã trích ở trên</div>`
        }</li>`;
    }).join("");

    // ── Các ô nhập ────────────────────────────────────────────────────────
    const fields = messages.map((m) => {
        const s = slots[m.order_index];
        const chuaNhap = m.body.trim() === "—" || m.body.trim() === "";
        const when: string[] = [];
        const sc = data.script;
        for (let d = 1; d <= sc.journey_days; d++) {
            for (let k = 0; k < sc.slots_per_day; k++) {
                if (messageIndexFor(d, k, sc.slots_per_day, messages.length) === m.order_index) {
                    when.push(`ngày ${d}·${config.journey.slotHours[k]}h`);
                }
            }
        }
        return `<div class="card" style="margin:12px 0${chuaNhap ? ";border-color:var(--gold)" : ""}">
            <div style="display:flex;align-items:baseline;gap:11px;flex-wrap:wrap;margin-bottom:7px">
                <span style="font-family:ui-monospace,monospace;font-size:19px;font-weight:700;color:var(--accent)">${m.order_index + 1}</span>
                <input type="text" name="label_${m.order_index}" value="${esc(m.label ?? s?.label ?? "")}"
                       style="flex:1;min-width:190px;max-width:320px;background:var(--card2);border:1px solid var(--line);border-radius:6px;padding:5px 9px;font:inherit;font-size:13px;color:var(--ink)">
                <span style="font-size:11.5px;color:var(--ink3)">${esc(when.join(" · "))}</span>
                ${chuaNhap ? badge("chưa nhập", "warn") : ""}
            </div>
            ${s ? `<p style="margin:0 0 7px;font-size:13px;color:var(--ink2);background:var(--accent-bg);border-radius:6px;padding:7px 11px">💡 ${esc(s.hint)}</p>` : ""}
            <textarea name="body_${m.order_index}" rows="4" placeholder="Nhập nội dung tin ${m.order_index + 1}…"
                      style="width:100%;background:var(--card2);border:1px solid var(--line);border-radius:7px;padding:10px 12px;font:inherit;font-size:14px;line-height:1.55;color:var(--ink);resize:vertical">${esc(chuaNhap ? "" : m.body)}</textarea>
            ${s?.seed ? `<details style="margin-top:6px"><summary style="cursor:pointer;font-size:12.5px;color:var(--accent)">Xem câu nhân viên đang dùng cho ý này</summary>
                <div class="msg" style="margin-top:6px">${esc(truncate(s.seed, 600))}</div></details>` : ""}
            <input type="text" name="media_${m.order_index}" value="${esc(m.media.join(", "))}"
                   placeholder="link ảnh, nhiều ảnh ngăn bằng dấu phẩy (bỏ trống nếu không có)"
                   style="width:100%;margin-top:7px;background:var(--card2);border:1px solid var(--line);border-radius:6px;padding:6px 10px;font:inherit;font-size:12.5px;color:var(--ink2)">
        </div>`;
    }).join("");

    const chuaXong = messages.filter((m) => m.body.trim() === "—" || !m.body.trim()).length;

    const body = `${crumb}
        <h1>Soạn nội dung <span class="sub">${esc(page.page_name)}</span></h1>
        ${banner}
        ${facts}
        ${card("Vấn đề khiến khách không chốt", objList ? `<ul style="margin:0;padding-left:20px">${objList}</ul>` : `<p class="empty">Chưa phát hiện băn khoăn nào.</p>`,
            "Các ô B2–B5 bên dưới dựng theo đúng danh sách này")}
        <p class="note">Số liệu lấy từ ${num(report.conversations)} hội thoại thật, phân tích lúc ${esc(dt(stored!.analyzed_at))}.
           Muốn cập nhật: chạy lại <code>npm run chat:phan-tich -- --page ${esc(page.page_id)}</code></p>
        <form method="POST" action="/page/${id}/script">
            ${fields}
            <div style="position:sticky;bottom:0;background:var(--card);border:1px solid var(--line);border-radius:11px;padding:14px 18px;margin:18px 0;display:flex;gap:12px;align-items:center;flex-wrap:wrap;box-shadow:0 -2px 12px rgba(0,0,0,.06)">
                <button type="submit" style="background:var(--accent);color:var(--card);border:0;border-radius:8px;padding:11px 26px;font:inherit;font-weight:700;cursor:pointer">Lưu nội dung</button>
                <a href="/page/${id}/script" style="color:var(--ink3)">Xem bản đang chạy</a>
                <span style="margin-left:auto;font-size:12.5px;${chuaXong ? "color:var(--gold);font-weight:600" : "color:var(--ink3)"}">
                    ${chuaXong ? `còn ${chuaXong}/${messages.length} ô chưa nhập` : `đã nhập đủ ${messages.length} ô`}
                </span>
            </div>
        </form>`;
    return layout(`Soạn · ${page.page_name}`, "home", body);
}

/** Tạo khung rỗng 12 tin từ gợi ý. Trả lỗi dạng chữ nếu không tạo được. */
export async function createSkeleton(id: number): Promise<string | null> {
    const stored = await scriptsRepo.getAnalysis(id);
    if (!stored) return "Chưa có số liệu phân tích cho page này";
    const page = await R.pageById(id);
    if (!page) return "Không có page này";

    const slots = suggestSlots(stored.report as unknown as ChatReport, 12);
    try {
        await scriptsRepo.createEmptyScript(
            id,
            `${page.page_name} — ${new Date().toISOString().slice(0, 10)}`,
            slots.map((s) => s.label)
        );
        return null;
    } catch (err) {
        return err instanceof Error ? err.message : String(err);
    }
}
