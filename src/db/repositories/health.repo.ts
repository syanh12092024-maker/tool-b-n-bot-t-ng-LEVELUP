import { query, queryOne } from "../pool.js";

/** Số liệu cho tầng giám sát sức khoẻ page + theo dõi lượt chạy của các job. */

export interface WindowStats {
    sent: number;
    failed: number;
    error2022: number;
    error121: number;
    total: number;
    errorRate: number;
}

/** Thống kê gửi của một page trong N phút gần nhất, đọc từ send_log. */
export async function statsLastMinutes(pageDbId: number, minutes: number): Promise<WindowStats> {
    const row = await queryOne<{ sent: number; failed: number; e2022: number; e121: number }>(
        `SELECT COUNT(*) FILTER (WHERE success)::int                       AS sent,
                COUNT(*) FILTER (WHERE NOT success)::int                   AS failed,
                COUNT(*) FILTER (WHERE error_kind = 'PAGE_BLOCKED')::int   AS e2022,
                COUNT(*) FILTER (WHERE error_kind = 'PAGE_QUOTA')::int     AS e121
           FROM send_log
          WHERE page_id = $1 AND sent_at >= now() - make_interval(mins => $2)`,
        [pageDbId, minutes]
    );
    const sent = row?.sent ?? 0;
    const failed = row?.failed ?? 0;
    const total = sent + failed;
    return {
        sent,
        failed,
        error2022: row?.e2022 ?? 0,
        error121: row?.e121 ?? 0,
        total,
        errorRate: total === 0 ? 0 : failed / total,
    };
}

export async function insertSnapshot(
    pageDbId: number,
    windowStart: Date,
    s: WindowStats,
    actionTaken: string | null
): Promise<void> {
    await query(
        `INSERT INTO page_health (page_id, window_start, sent, failed, error_2022, error_121, error_rate, action_taken)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (page_id, window_start) DO UPDATE SET
             sent = EXCLUDED.sent, failed = EXCLUDED.failed,
             error_2022 = EXCLUDED.error_2022, error_121 = EXCLUDED.error_121,
             error_rate = EXCLUDED.error_rate,
             action_taken = COALESCE(EXCLUDED.action_taken, page_health.action_taken),
             computed_at = now()`,
        [pageDbId, windowStart.toISOString(), s.sent, s.failed, s.error2022, s.error121, s.errorRate.toFixed(4), actionTaken]
    );
}

// ─── Lượt chạy job ────────────────────────────────────────────────────────────

export async function startJobRun(job: string, pageDbId?: number): Promise<number> {
    const row = await queryOne<{ id: number }>(
        `INSERT INTO job_runs (job, page_id) VALUES ($1, $2) RETURNING id`,
        [job, pageDbId ?? null]
    );
    if (!row) throw new Error("Không tạo được job_run");
    return row.id;
}

export async function finishJobRun(
    id: number,
    ok: boolean,
    stats: Record<string, unknown>,
    error?: string
): Promise<void> {
    await query(
        `UPDATE job_runs SET finished_at = now(), ok = $2, stats = $3, error = $4 WHERE id = $1`,
        [id, ok, JSON.stringify(stats), error ? error.slice(0, 1000) : null]
    );
}

/** Lượt chạy gần nhất của mỗi job — cho lệnh check:db và dashboard. */
export function recentRuns(limit = 20) {
    return query<{
        job: string;
        page_id: number | null;
        started_at: Date;
        finished_at: Date | null;
        ok: boolean | null;
        stats: Record<string, unknown>;
        error: string | null;
    }>(
        `SELECT job, page_id, started_at, finished_at, ok, stats, error
           FROM job_runs ORDER BY started_at DESC LIMIT $1`,
        [limit]
    );
}
