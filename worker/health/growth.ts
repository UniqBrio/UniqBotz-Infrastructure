import type pg from "pg";
import { qi, ql } from "../connection/connect";

/**
 * SIX-MONTH GROWTH — "average records added per day over the last six months".
 *
 * Exact calculation (ADR D-15, Phase 3B §11):
 *   • Window     = the last 6 COMPLETE calendar months in the application's time zone:
 *                  [first day of (current month − 6), first day of current month). The current month —
 *                  and therefore the current, partial day — is excluded.
 *   • Counted    = rows whose INSERTION timestamp falls in the window. The insertion column must be a
 *                  timestamp whose DEFAULT is the current time (discovered) or explicitly configured.
 *                  Business/event dates are NOT used (a backfilled import would look like old data).
 *   • Average    = counted rows ÷ days in the window (day-weighted, matches Phase 1 averageDailyGrowth).
 *   • Deleted rows: rows inserted in the window and deleted since are NOT counted → the figure is a
 *                  lower bound until snapshot history (net growth) exists. Reported as `countsSurvivingRowsOnly`.
 *   • Backfills: days above 5× the median daily count are flagged; the average is also reported without them.
 *   • INSUFFICIENT HISTORY when there is no provable insertion column, or when the oldest surviving row is
 *                  newer than the window start (the table cannot be shown to have recorded the whole window).
 *                  Growth is never inferred from the current row count alone.
 */
export type GrowthResult =
  | {
      status: "measured";
      method: "insertion_timestamp";
      column: string;
      timeZone: string;
      windowStart: string; // YYYY-MM-DD inclusive
      windowEnd: string; // YYYY-MM-DD exclusive
      days: number;
      recordsInWindow: number;
      avgPerDay: number;
      monthly: { month: string; recordsAdded: number; daysInMonth: number }[];
      spikeDays: { day: string; rows: number }[];
      avgPerDayExcludingSpikes: number;
      countsSurvivingRowsOnly: true;
      computedAt: string;
    }
  | { status: "insufficient_history"; reason: string; column: string | null; timeZone: string; computedAt: string };

export function growthWindow(todayLocal: string): { start: string; end: string; months: { month: string; days: number }[] } {
  const [y, m] = todayLocal.split("-").map(Number) as [number, number];
  const months: { month: string; days: number }[] = [];
  for (let i = 6; i >= 1; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    const days = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    months.push({ month: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`, days });
  }
  return { start: `${months[0]!.month}-01`, end: `${y}-${String(m).padStart(2, "0")}-01`, months };
}

export function detectSpikes(daily: { day: string; rows: number }[], factor = 5): { day: string; rows: number }[] {
  if (daily.length < 7) return [];
  const sorted = daily.map((d) => d.rows).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  if (median === 0) return [];
  return daily.filter((d) => d.rows > factor * median);
}

export async function measureGrowth(
  c: pg.Client,
  table: string,
  insertionColumn: string | null,
  timeZone: string,
  todayLocal: string,
): Promise<GrowthResult> {
  const computedAt = new Date().toISOString();
  if (!insertionColumn) {
    return { status: "insufficient_history", reason: "no insertion timestamp column (timestamp with a now()-style default) was found or configured", column: null, timeZone, computedAt };
  }
  const w = growthWindow(todayLocal);
  const col = qi(insertionColumn);
  const tz = ql(timeZone);
  const start = `(timestamp ${ql(`${w.start} 00:00`)} AT TIME ZONE ${tz})`;
  const end = `(timestamp ${ql(`${w.end} 00:00`)} AT TIME ZONE ${tz})`;
  const oldest = (await c.query(`SELECT min(${col}) AS m FROM ${qi(table)}`)).rows[0].m as Date | null;
  if (!oldest || oldest.getTime() > new Date((await c.query(`SELECT ${start} AS s`)).rows[0].s).getTime()) {
    return { status: "insufficient_history", reason: oldest ? `oldest surviving row (${oldest.toISOString()}) is newer than the window start ${w.start}` : "table is empty", column: insertionColumn, timeZone, computedAt };
  }
  const daily = (await c.query(
    `SELECT (${col} AT TIME ZONE ${tz})::date::text AS day, count(*)::bigint AS n
     FROM ${qi(table)} WHERE ${col} >= ${start} AND ${col} < ${end} GROUP BY 1 ORDER BY 1`)).rows.map((r) => ({ day: r.day as string, rows: Number(r.n) }));
  const days = w.months.reduce((s, m) => s + m.days, 0);
  const total = daily.reduce((s, d) => s + d.rows, 0);
  const spikes = detectSpikes(daily);
  const spikeRows = spikes.reduce((s, d) => s + d.rows, 0);
  return {
    status: "measured",
    method: "insertion_timestamp",
    column: insertionColumn,
    timeZone,
    windowStart: w.start,
    windowEnd: w.end,
    days,
    recordsInWindow: total,
    avgPerDay: Math.round(total / days),
    monthly: w.months.map((m) => ({ month: m.month, daysInMonth: m.days, recordsAdded: daily.filter((d) => d.day.startsWith(m.month)).reduce((s, d) => s + d.rows, 0) })),
    spikeDays: spikes,
    avgPerDayExcludingSpikes: Math.round((total - spikeRows) / Math.max(1, days - spikes.length)),
    countsSurvivingRowsOnly: true,
    computedAt,
  };
}
