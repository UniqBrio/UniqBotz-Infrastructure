/**
 * PROTOTYPE / SYNTHETIC DATA ONLY — P10 Database storage after DELETE (ADR §7.4, §15, attack #1/#18).
 * Uses a DEDICATED database (storage_synth) created only for this experiment, including VACUUM FULL
 * and read-only-mode simulation. Never run against a real database.
 */
import { DBS, connect, ms, now } from "./lib/db.ts";
import { FINGERPRINT } from "./lib/schema.ts";
import { Recorder } from "./lib/results.ts";

const rec = new Recorder("p10-storage", "P10 — Database storage after DELETE");
const DB = "storage_synth";
const admin = await connect("postgres", { pin: false });
await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${DB}`);
await admin.end();
const c = await connect(DB);
await c.query(`SELECT setseed(0.5)`);
await c.query(`CREATE TABLE attendance (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, member_id bigint NOT NULL, attendance_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), note text)`);
await c.query(`INSERT INTO attendance (member_id, attendance_date, created_at, note)
  SELECT g % 5000, date '2023-01-01' + floor(random() * 1000)::int, now(), CASE WHEN g % 5 = 0 THEN 'synthetic note ' || g END
  FROM generate_series(1, 600000) g`);
await c.query(`CREATE INDEX ON attendance (attendance_date); ANALYZE attendance`);

const snap = async (label: string) => {
  const r = (await c.query(`SELECT pg_database_size(current_database())::bigint db, pg_relation_size('attendance')::bigint heap,
      pg_indexes_size('attendance')::bigint idx, n_live_tup::bigint live, n_dead_tup::bigint dead, last_autovacuum, autovacuum_count::int av
    FROM pg_stat_user_tables WHERE relname = 'attendance'`)).rows[0];
  const out = { label, dbMB: +(r.db / 1048576).toFixed(1), heapMB: +(r.heap / 1048576).toFixed(1), indexMB: +(r.idx / 1048576).toFixed(1), live: Number(r.live), dead: Number(r.dead), autovacuumed: r.av > 0 };
  console.log(out);
  return out;
};
const series: Awaited<ReturnType<typeof snap>>[] = [];
const baseline = await snap("1 baseline (600k rows)");
series.push(baseline);

// archive-style exact deletion of the 125k oldest rows (whole days), batches of 2,000
const keys = (await c.query(`SELECT id::text pk, ${FINGERPRINT("t")} fp FROM attendance t ORDER BY attendance_date, id LIMIT 125000`)).rows as { pk: string; fp: string }[];
const lsn0 = (await c.query(`SELECT pg_current_wal_lsn() l`)).rows[0].l;
let t = now();
for (let i = 0; i < keys.length; i += 2000) {
  const b = keys.slice(i, i + 2000);
  await c.query(`WITH m(pk, fp) AS (SELECT * FROM unnest($1::text[], $2::text[]))
                 DELETE FROM attendance t USING m WHERE t.id = m.pk::bigint AND ${FINGERPRINT("t")} = m.fp`, [b.map((x) => x.pk), b.map((x) => x.fp)]);
}
rec.measure("delete_125k_ms", Math.round(ms(t)));
rec.measure("wal_generated_by_delete_MB", +(Number((await c.query(`SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), $1) d`, [lsn0])).rows[0].d) / 1048576).toFixed(1));
await c.query(`ANALYZE attendance`);
const afterDelete = await snap("2 immediately after deleting 125k");
series.push(afterDelete);

// observe autovacuum alone for up to 90 s (record, do not rely on it)
t = now();
let av = afterDelete;
for (let i = 0; i < 18 && av.dead > 1000; i++) { await new Promise((r) => setTimeout(r, 5000)); av = await snap("…observing autovacuum"); }
rec.measure("autovacuum_alone_after_90s", { deadTuplesRemaining: av.dead, secondsObserved: Math.round(ms(t) / 1000) });
series.push({ ...av, label: "3a autovacuum alone (observed)" });
// the recommended post-job step: explicit plain VACUUM (no exclusive lock)
t = now();
await c.query(`VACUUM (ANALYZE) attendance`);
rec.measure("explicit_vacuum_ms", Math.round(ms(t)));
await new Promise((r) => setTimeout(r, 1500)); // stats are flushed asynchronously
const afterVacuum = await snap("3b after explicit VACUUM");
series.push(afterVacuum);

// insert 125k new rows: is the freed space reused?
await c.query(`INSERT INTO attendance (member_id, attendance_date, created_at) SELECT g % 5000, current_date, now() FROM generate_series(1, 125000) g`);
await c.query(`ANALYZE attendance`);
const afterReinsert = await snap("4 after inserting 125k new rows");
series.push(afterReinsert);

// same insert on a table WITHOUT prior deletion, for comparison
await c.query(`CREATE TABLE attendance_ctrl AS SELECT * FROM attendance LIMIT 0`);
const ctrl0 = Number((await c.query(`SELECT pg_database_size(current_database()) n`)).rows[0].n);
await c.query(`INSERT INTO attendance_ctrl (id, member_id, attendance_date, created_at) SELECT g, g % 5000, current_date, now() FROM generate_series(1, 125000) g`);
const ctrlGrowthMB = +((Number((await c.query(`SELECT pg_database_size(current_database()) n`)).rows[0].n) - ctrl0) / 1048576).toFixed(1);
await c.query(`DROP TABLE attendance_ctrl`);
rec.measure("heap_growth_for_125k_inserts_into_fresh_table_MB", ctrlGrowthMB);

rec.check("DELETE does not reduce database size immediately (after ≥ before − 0.5 MB)", true, afterDelete.dbMB >= baseline.dbMB - 0.5);
rec.check("plain VACUUM does not return space for scattered deletes (heap unchanged)", true, Math.abs(afterVacuum.heapMB - afterDelete.heapMB) < 1);
rec.check("explicit VACUUM clears dead tuples", true, afterVacuum.dead < 1000);
rec.check("freed space is reused: re-inserting 125k rows grows the heap far less than a fresh table", true, afterReinsert.heapMB - afterVacuum.heapMB < ctrlGrowthMB / 2);

// ---- VACUUM FULL (dedicated experiment DB only) ----
const blocker = await connect(DB);
await c.query(`DELETE FROM attendance WHERE id IN (SELECT id FROM attendance ORDER BY id LIMIT 200000)`); // make room to reclaim
await c.query(`VACUUM attendance`);
const beforeFull = await snap("5 before VACUUM FULL (after another 200k delete + VACUUM)");
series.push(beforeFull);
let tb = now();
await blocker.query(`SELECT count(*) FROM attendance`);
const baselineReadMs = ms(tb);
t = now();
const full = c.query(`VACUUM FULL attendance`);
await new Promise((r) => setTimeout(r, 100));
tb = now();
await blocker.query(`SELECT count(*) FROM attendance`);
const blockedReadMs = ms(tb);
await full;
rec.measure("vacuum_full_ms", Math.round(ms(t)));
rec.measure("read_latency_ms", { baseline: Math.round(baselineReadMs), duringVacuumFull: Math.round(blockedReadMs) });
const afterFull = await snap("6 after VACUUM FULL");
series.push(afterFull);
rec.check("VACUUM FULL returns space (heap shrinks)", true, afterFull.heapMB < beforeFull.heapMB * 0.8);
rec.check("VACUUM FULL blocks ordinary reads while it runs (read waits ≫ baseline)", true, blockedReadMs > 5 * baselineReadMs && blockedReadMs > 200);
await blocker.end();

// ---- near capacity: Supabase-style read-only mode (default_transaction_read_only) ----
await c.query(`ALTER DATABASE ${DB} SET default_transaction_read_only = on`);
const ro = await connect(DB);
let roCode = "";
try { await ro.query(`DELETE FROM attendance WHERE id = (SELECT min(id) FROM attendance)`); } catch (e) { roCode = (e as { code?: string }).code ?? String(e); }
rec.check("in read-only mode the archiver's DELETE fails (25006)", "25006", roCode);
await ro.query(`SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE`);
const esc = await ro.query(`DELETE FROM attendance WHERE id = (SELECT min(id) FROM attendance)`);
rec.check("documented session escape re-enables writes for that session", 1, esc.rowCount);
rec.note("default_transaction_read_only is a session default, not a privilege boundary: any role can override it. How hosted Supabase enforces read-only mode must be confirmed on a real project; the worker must never auto-escape.");
await ro.end();
await c.query(`ALTER DATABASE ${DB} RESET default_transaction_read_only`);

rec.measure("size_series", series);
await c.end();
rec.save();
