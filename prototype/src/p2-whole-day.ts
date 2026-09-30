/**
 * PROTOTYPE / SYNTHETIC DATA ONLY — P2 Whole-day target logic (ADR §3, DOC §5).
 * Three independent tables (different date column types) → per-day totals in the business
 * time zone → Phase 1 selectWholeDays() unchanged → exact freeze in one snapshot.
 */
import { selectWholeDays } from "../../src/lib/domain/selection.ts";
import type { CandidateDay } from "../../src/lib/domain/types.ts";
import { DBS, connect } from "./lib/db.ts";
import { Recorder } from "./lib/results.ts";

const rec = new Recorder("p2-whole-day", "P2 — Whole-day target logic");
const TZ = "Asia/Kolkata";

// ---------- build dataset ----------
const admin = await connect("postgres", { pin: false });
await admin.query(`DROP DATABASE IF EXISTS ${DBS.wholeDay} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${DBS.wholeDay}`);
await admin.end();
const c = await connect(DBS.wholeDay);
await c.query(`
  CREATE TABLE table_a (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, event_at timestamptz);   -- timestamptz
  CREATE TABLE table_b (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, event_date date);        -- date
  CREATE TABLE table_c (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, created_at timestamptz);`);

const days: string[] = [];
for (let d = new Date("2025-05-01T00:00:00Z"); d <= new Date("2025-07-30T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1)) {
  const s = d.toISOString().slice(0, 10);
  if (s >= "2025-06-15" && s <= "2025-06-17") continue; // three zero-row days
  days.push(s);
}
const base = Math.floor(124_999 / days.length);
const rem = 124_999 - base * days.length;
const plan: { day: string; a: number; b: number; c: number }[] = days.map((day, i) => {
  const n = base + (i < rem ? 1 : 0);
  const a = Math.floor(n * 0.4), b = Math.floor(n * 0.35);
  return { day, a, b, c: n - a - b };
});
plan.push({ day: "2025-07-31", a: 60, b: 70, c: 80 });
for (const day of ["2025-08-01", "2025-08-02", "2025-08-03"]) plan.push({ day, a: 500, b: 400, c: 300 });

const ins = async (table: string, col: string, kind: "tz" | "date", key: "a" | "b" | "c") =>
  c.query(
    `INSERT INTO ${table} (${col})
     SELECT ${kind === "date" ? "p.day" : `(p.day + time '09:00' + (g % 43200) * interval '1 second') AT TIME ZONE '${TZ}'`}
     FROM unnest($1::date[], $2::int[]) p(day, n), generate_series(1, p.n) g`,
    [plan.map((p) => p.day), plan.map((p) => p[key])],
  );
await ins("table_a", "event_at", "tz", "a");
await ins("table_b", "event_date", "date", "b");
await ins("table_c", "created_at", "tz", "c");

// time-zone edge rows: move one July-31 row of table_a to 23:59:59 IST, and add one row at 00:00:00 IST Aug 1
await c.query(`UPDATE table_a SET event_at = timestamptz '2025-07-31 23:59:59+05:30'
               WHERE id = (SELECT min(id) FROM table_a WHERE (event_at AT TIME ZONE '${TZ}')::date = '2025-07-31')`);
await c.query(`UPDATE table_a SET event_at = timestamptz '2025-08-01 00:00:00+05:30'
               WHERE id = (SELECT min(id) FROM table_a WHERE (event_at AT TIME ZONE '${TZ}')::date = '2025-08-01')`);
// NULL-date rows in every table
await c.query(`INSERT INTO table_a (event_at) SELECT NULL FROM generate_series(1, 111);
               INSERT INTO table_b (event_date) SELECT NULL FROM generate_series(1, 222);
               INSERT INTO table_c (created_at) SELECT NULL FROM generate_series(1, 333);`);
await c.query("ANALYZE");

// ---------- per-day totals in the business time zone ----------
const cutoff = "2025-09-01";
const TABLES = [
  { t: "table_a", col: "event_at", dayExpr: `(event_at AT TIME ZONE '${TZ}')::date`, pred: `event_at < (timestamp '${cutoff}' AT TIME ZONE '${TZ}')` },
  { t: "table_b", col: "event_date", dayExpr: `event_date`, pred: `event_date < date '${cutoff}'` },
  { t: "table_c", col: "created_at", dayExpr: `(created_at AT TIME ZONE '${TZ}')::date`, pred: `created_at < (timestamp '${cutoff}' AT TIME ZONE '${TZ}')` },
];
const byDay = new Map<string, Record<string, number>>();
for (const x of TABLES) {
  const r = await c.query(`SELECT ${x.dayExpr}::text d, count(*)::int n FROM ${x.t} WHERE ${x.pred} GROUP BY 1`);
  for (const row of r.rows) byDay.set(row.d, { ...(byDay.get(row.d) ?? {}), [x.t]: row.n });
}
const candidateDays: CandidateDay[] = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, countsByTable]) => ({ date, countsByTable }));
const nulls = (await c.query(`SELECT (SELECT count(*) FROM table_a WHERE event_at IS NULL) + (SELECT count(*) FROM table_b WHERE event_date IS NULL)
                               + (SELECT count(*) FROM table_c WHERE created_at IS NULL) AS n`)).rows[0].n;
rec.check("NULL-date rows never appear in any day", 0, candidateDays.filter((d) => d.date === null).length);
rec.measure("null_date_rows_excluded", Number(nulls));
rec.check("zero-row days absent from aggregation (2025-06-15..17)", [], candidateDays.filter((d) => d.date >= "2025-06-15" && d.date <= "2025-06-17").map((d) => d.date));

const sel = selectWholeDays(candidateDays, 125_000);
rec.check("running total before final day", 124_999, sel.totalBeforeFinalDay);
rec.check("final day is 2025-07-31", "2025-07-31", sel.boundaryDate);
rec.check("final day total = 60 + 70 + 80", 210, sel.finalDayCount);
rec.check("final day per table", { table_a: 60, table_b: 70, table_c: 80 }, candidateDays.find((d) => d.date === "2025-07-31")!.countsByTable);
rec.check("selection = 125,209 (not 125,000)", 125_209, sel.totalSelected);

// ---------- freeze in one snapshot and prove July 31 is whole ----------
await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
let frozen = 0;
let july31Frozen = 0;
let aug1Frozen = 0;
const end = "2025-08-01";
for (const x of TABLES) {
  const endPred = x.t === "table_b" ? `event_date < date '${end}'` : `${x.col} < (timestamp '${end}' AT TIME ZONE '${TZ}')`;
  const r = await c.query(`SELECT count(*)::int n,
      count(*) FILTER (WHERE ${x.dayExpr} = date '2025-07-31')::int j31,
      count(*) FILTER (WHERE ${x.dayExpr} = date '2025-08-01')::int a1
    FROM ${x.t} WHERE ${endPred}`);
  frozen += r.rows[0].n; july31Frozen += r.rows[0].j31; aug1Frozen += r.rows[0].a1;
}
const july31All = (await c.query(`SELECT
   (SELECT count(*) FROM table_a WHERE (event_at AT TIME ZONE '${TZ}')::date = '2025-07-31')
 + (SELECT count(*) FROM table_b WHERE event_date = '2025-07-31')
 + (SELECT count(*) FROM table_c WHERE (created_at AT TIME ZONE '${TZ}')::date = '2025-07-31') AS n`)).rows[0].n;
await c.query("COMMIT");
rec.check("frozen set size = 125,209", 125_209, frozen);
rec.check("ALL July 31 rows are in the frozen set (none split)", Number(july31All), july31Frozen);
rec.check("no August 1 rows in the frozen set", 0, aug1Frozen);

// time-zone boundary evidence
const edge = (await c.query(`SELECT
   count(*) FILTER (WHERE (event_at AT TIME ZONE '${TZ}')::date = '2025-07-31')::int ist_jul31,
   count(*) FILTER (WHERE (event_at AT TIME ZONE 'UTC')::date = '2025-07-31')::int utc_jul31
 FROM table_a WHERE event_at IS NOT NULL`)).rows[0];
rec.check("23:59:59 IST row counts as July 31 in Asia/Kolkata", 60, edge.ist_jul31);
rec.measure("table_a_rows_on_2025-07-31_if_grouped_in_UTC", edge.utc_jul31);
rec.note(`Grouping by UTC day would give table_a ${edge.utc_jul31} rows on 2025-07-31 instead of 60 — the business time zone must be pinned per application.`);
await c.end();

// ---------- rule edge cases (pure function, Phase 1 code unchanged) ----------
const D = (date: string, n: number): CandidateDay => ({ date, countsByTable: { t: n } });
const exact = selectWholeDays([D("d1", 60_000), D("d2", 65_000), D("d3", 10)], 125_000);
rec.check("target reached exactly → stop on that day", [125_000, "d2", true], [exact.totalSelected, exact.boundaryDate, exact.reachedTarget]);
const crossed = selectWholeDays([D("d1", 124_999), D("d2", 210), D("d3", 5)], 125_000);
rec.check("target crossed → whole final day", [125_209, "d2"], [crossed.totalSelected, crossed.boundaryDate]);
const never = selectWholeDays([D("d1", 50_000), D("d2", 40_000)], 125_000);
rec.check("target never reached → reachedTarget=false, all eligible days listed (no job decided here)", [false, 90_000, 2], [never.reachedTarget, never.totalSelected, never.selectedDays.length]);
const huge = selectWholeDays([D("d1", 300_000), D("d2", 10)], 125_000);
rec.check("one day larger than target → that whole day only (300,000)", [300_000, "d1", 1], [huge.totalSelected, huge.boundaryDate, huge.selectedDays.length]);
const zeros = selectWholeDays([D("d1", 0), D("d2", 100_000), D("d3", 0), D("d4", 30_000)], 125_000);
rec.check("explicit zero-row days are harmless", [130_000, "d4"], [zeros.totalSelected, zeros.boundaryDate]);
const unordered = selectWholeDays([D("2025-07-31", 210), D("2025-07-30", 124_999)], 125_000);
rec.check("input order irrelevant (ascending processing)", ["2025-07-30", "2025-07-31", 125_209], [unordered.oldestDate, unordered.boundaryDate, unordered.totalSelected]);
rec.save();
