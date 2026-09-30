/**
 * PROTOTYPE / SYNTHETIC DATA ONLY — P6 Delete batch performance (ADR §11, D-14).
 * Exact PK + fingerprint deletes in one transaction per batch, with a concurrent synthetic
 * "application" updating/inserting rows in the same table. Container limited to 0.5 CPU / 512 MB.
 */
import { DBS, connect, ms, now } from "./lib/db.ts";
import { FINGERPRINT } from "./lib/schema.ts";
import { Recorder } from "./lib/results.ts";

const rec = new Recorder("p6-delete-performance", "P6 — Delete performance");
const c = await connect(DBS.rosifit);
const app = await connect(DBS.rosifit, { appName: "synthetic-app" });

await c.query(`DROP TABLE IF EXISTS perf_attendance`);
let t = now();
await c.query(`CREATE TABLE perf_attendance AS SELECT * FROM public.attendance_records`);
await c.query(`ALTER TABLE perf_attendance ADD PRIMARY KEY (id)`);
await c.query(`CREATE INDEX ON perf_attendance (attendance_date)`);
await c.query(`CREATE INDEX ON perf_attendance (member_id)`);
await c.query(`ANALYZE perf_attendance`);
rec.measure("copy_setup_ms", Math.round(ms(t)));
const totalRows = Number((await c.query(`SELECT count(*) n FROM perf_attendance`)).rows[0].n);
rec.measure("table_rows", totalRows);
rec.measure("table_size_before", (await c.query(`SELECT pg_size_pretty(pg_total_relation_size('perf_attendance')) s`)).rows[0].s);

const PER_SIZE = 50_000;
const SIZES = [500, 1_000, 2_000, 5_000, 10_000];
// Candidate keys ordered like an archive (oldest dates first); each batch size gets its own 50k slice.
const keys = (await c.query(
  `SELECT id::text pk, ${FINGERPRINT("t")} fp FROM perf_attendance t WHERE attendance_date IS NOT NULL
   ORDER BY attendance_date, id LIMIT ${PER_SIZE * SIZES.length}`)).rows as { pk: string; fp: string }[];

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0; };

async function runSize(size: number, slice: { pk: string; fp: string }[]) {
  // concurrent synthetic app: touches rows in the same slice (row-lock contention) + inserts new rows
  let stop = false;
  const appLat: number[] = [];
  let appOps = 0;
  const appLoop = (async () => {
    while (!stop) {
      const target = slice[Math.floor(Math.random() * slice.length)]!.pk;
      const s = now();
      await app.query(`UPDATE perf_attendance SET checked_in_at = checked_in_at WHERE id = $1`, [target]); // no-op content change
      await app.query(`INSERT INTO perf_attendance (id, member_id, course_id, attendance_date, created_at)
                       VALUES (nextval(pg_get_serial_sequence('public.attendance_records','id')), 1, 1, current_date, now())`);
      appLat.push(ms(s));
      appOps++;
      await new Promise((r) => setTimeout(r, 10));
    }
  })();
  const walStart = (await c.query(`SELECT pg_current_wal_lsn() l`)).rows[0].l;
  const batchMs: number[] = [];
  let deleted = 0;
  const t0 = now();
  for (let i = 0; i < slice.length; i += size) {
    const b = slice.slice(i, i + size);
    const s = now();
    await c.query("BEGIN");
    await c.query(`SET LOCAL lock_timeout = '2000ms'; SET LOCAL statement_timeout = '30000ms'`);
    const r = await c.query(
      `WITH m(pk, fp) AS (SELECT * FROM unnest($1::text[], $2::text[]))
       DELETE FROM perf_attendance t USING m WHERE t.id = m.pk::bigint AND ${FINGERPRINT("t")} = m.fp`,
      [b.map((x) => x.pk), b.map((x) => x.fp)]);
    await c.query("COMMIT");
    batchMs.push(ms(s));
    deleted += r.rowCount ?? 0;
  }
  const totalMs = ms(t0);
  stop = true;
  await appLoop;
  const wal = Number((await c.query(`SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), $1) d`, [walStart])).rows[0].d);
  return {
    batchSize: size,
    batches: batchMs.length,
    deleted,
    totalMs: Math.round(totalMs),
    rowsPerSec: Math.round(deleted / (totalMs / 1000)),
    txnMsP50: Math.round(pct(batchMs, 0.5)),
    txnMsP95: Math.round(pct(batchMs, 0.95)),
    txnMsMax: Math.round(Math.max(...batchMs)),
    walBytesPerBatch: Math.round(wal / batchMs.length),
    appOps,
    appLatencyMsP50: Math.round(pct(appLat, 0.5)),
    appLatencyMsP95: Math.round(pct(appLat, 0.95)),
    appLatencyMsMax: Math.round(Math.max(...appLat)),
  };
}

const table: unknown[] = [];
for (let i = 0; i < SIZES.length; i++) {
  const r = await runSize(SIZES[i]!, keys.slice(i * PER_SIZE, (i + 1) * PER_SIZE));
  table.push(r);
  console.log(r);
  rec.check(`batch ${SIZES[i]}: all ${PER_SIZE} frozen rows deleted`, PER_SIZE, r.deleted);
}
rec.measure("batch_size_results", table);

// ---- lock-conflict failure + safe retry (batch 2,000) ----
const extra = (await c.query(`SELECT id::text pk, ${FINGERPRINT("t")} fp FROM perf_attendance t WHERE attendance_date IS NOT NULL ORDER BY attendance_date, id LIMIT 2000`)).rows as { pk: string; fp: string }[];
await app.query("BEGIN");
await app.query(`SELECT 1 FROM perf_attendance WHERE id = $1 FOR UPDATE`, [extra[1000]!.pk]); // app holds a row lock
let failure = "";
const s1 = now();
try {
  await c.query("BEGIN");
  await c.query(`SET LOCAL lock_timeout = '2000ms'`);
  await c.query(`WITH m(pk, fp) AS (SELECT * FROM unnest($1::text[], $2::text[]))
                 DELETE FROM perf_attendance t USING m WHERE t.id = m.pk::bigint AND ${FINGERPRINT("t")} = m.fp`,
    [extra.map((x) => x.pk), extra.map((x) => x.fp)]);
  await c.query("COMMIT");
} catch (e) {
  failure = (e as { code?: string }).code ?? String(e);
  await c.query("ROLLBACK");
}
const failMs = ms(s1);
const stillThere = Number((await c.query(`SELECT count(*) n FROM perf_attendance WHERE id = ANY($1::bigint[])`, [extra.map((x) => x.pk)])).rows[0].n);
rec.check("batch blocked by an app row lock fails with lock_timeout (55P03)", "55P03", failure);
rec.check("failed batch rolled back completely (0 of 2,000 deleted)", 2000, stillThere);
rec.measure("lock_timeout_failure_ms", Math.round(failMs));
await app.query("COMMIT"); // app releases
const retry = await c.query(`WITH m(pk, fp) AS (SELECT * FROM unnest($1::text[], $2::text[]))
   DELETE FROM perf_attendance t USING m WHERE t.id = m.pk::bigint AND ${FINGERPRINT("t")} = m.fp`,
  [extra.map((x) => x.pk), extra.map((x) => x.fp)]);
rec.check("retry after release deletes the whole batch", 2000, retry.rowCount);
const retry2 = await c.query(`WITH m(pk, fp) AS (SELECT * FROM unnest($1::text[], $2::text[]))
   DELETE FROM perf_attendance t USING m WHERE t.id = m.pk::bigint AND ${FINGERPRINT("t")} = m.fp`,
  [extra.map((x) => x.pk), extra.map((x) => x.fp)]);
rec.check("re-running a committed batch is idempotent (0 more rows)", 0, retry2.rowCount);

// ---- guard overhead: same 10k rows with vs without fingerprint check (inside rolled-back txns) ----
const probe = (await c.query(`SELECT id::text pk, ${FINGERPRINT("t")} fp FROM perf_attendance t WHERE attendance_date IS NOT NULL ORDER BY attendance_date, id LIMIT 10000`)).rows as { pk: string; fp: string }[];
const timeIt = async (sql: string, params: unknown[]) => { await c.query("BEGIN"); const s = now(); await c.query(sql, params); const d = ms(s); await c.query("ROLLBACK"); return Math.round(d); };
rec.measure("guard_overhead_10k_rows_ms", {
  pkOnly: await timeIt(`DELETE FROM perf_attendance WHERE id = ANY($1::bigint[])`, [probe.map((x) => x.pk)]),
  pkPlusFingerprint: await timeIt(`WITH m(pk, fp) AS (SELECT * FROM unnest($1::text[], $2::text[]))
     DELETE FROM perf_attendance t USING m WHERE t.id = m.pk::bigint AND ${FINGERPRINT("t")} = m.fp`, [probe.map((x) => x.pk), probe.map((x) => x.fp)]),
});
rec.measure("dead_tuples_after", (await c.query(`SELECT n_dead_tup::bigint FROM pg_stat_user_tables WHERE relname='perf_attendance'`)).rows[0]);
await c.query(`DROP TABLE perf_attendance`);
await app.end();
await c.end();
rec.save();
