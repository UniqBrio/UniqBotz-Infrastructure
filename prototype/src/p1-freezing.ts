/**
 * PROTOTYPE / SYNTHETIC DATA ONLY — P1 Exact candidate freezing (ADR §2, D-01/D-03).
 * Freeze exact PKs + row fingerprints in one snapshot, export, verify, then mutate candidates
 * and prove deletion only removes unchanged frozen rows.
 */
import { DBS, connect, ms, now } from "./lib/db.ts";
import { exportGroup } from "./lib/archive.ts";
import { buildContext, deleteBatch, expandBatch, rootBatches } from "./lib/deleter.ts";
import { planGroup, selectCandidate } from "./lib/group.ts";
import { Recorder } from "./lib/results.ts";
import { verifyArchive } from "./lib/verify.ts";
import { FINGERPRINT, FINGERPRINT_MD5 } from "./lib/schema.ts";

const rec = new Recorder("p1-freezing", "P1 — Exact candidate freezing");
const c = await connect(DBS.rosifit);

const plan = await planGroup(c, {
  applicationId: "rosifit-synth",
  database: DBS.rosifit,
  root: "public.attendance_records",
  dateColumn: "attendance_date",
  tables: ["public.attendance_records"],
  timeZone: "Asia/Kolkata",
  cutoffDay: "2025-09-30",
  target: 5_000,
});
rec.check("plan has no blocking issues", [], plan.blocking);

const sel = await selectCandidate(c, plan);
rec.measure("selection", { oldest: sel.oldestDate, boundary: sel.boundaryDate, total: sel.totalSelected, beforeFinal: sel.totalBeforeFinalDay, finalDay: sel.finalDayCount, nullDateRows: sel.nullDateRows });

const jobId = "P1-" + Date.now();
const t0 = now();
const { manifest, manifestSha256, dir } = await exportGroup(c, plan, sel, jobId, 1);
rec.measure("export_ms", Math.round(ms(t0)));
const table = "public.attendance_records";
rec.check("frozen rows = selected whole-day total", sel.totalSelected, manifest.tables[table]!.rows);

const expected = {
  manifestSha256,
  files: Object.fromEntries(Object.values(manifest.tables).flatMap((t) => [[t.data.path, { bytes: t.data.bytes, sha256: t.data.sha256 }], [t.keys.path, { bytes: t.keys.bytes, sha256: t.keys.sha256 }]])),
  rowsByTable: { [table]: manifest.tables[table]!.rows },
  schemaHash: plan.schemaHash,
  boundary: { firstDay: sel.oldestDate, lastDay: sel.boundaryDate },
};
const v = await verifyArchive(dir, expected);
rec.check("archive verification passed", true, v.passed);

// ---- concurrent application activity AFTER freeze/verification, BEFORE deletion ----
const ctx = await buildContext(dir, manifest, plan.schemas, plan.edges);
const keys = ctx.keys[table]!;
const changedPk = keys[10]!.pk;
const appDeletedPk = keys[20]!.pk;
await c.query(`UPDATE public.attendance_records SET note = 'edited after export', updated_at = now() WHERE id = $1`, [changedPk]);
await c.query(`DELETE FROM public.attendance_records WHERE id = $1`, [appDeletedPk]);
const newInRange = (await c.query(
  `INSERT INTO public.attendance_records (member_id, course_id, attendance_date, created_at, note)
   VALUES (1, 1, $1::date, now(), 'new row inside archived range') RETURNING id::text`, [sel.boundaryDate])).rows[0].id;
const backdated = (await c.query(
  `INSERT INTO public.attendance_records (member_id, course_id, attendance_date, created_at, note)
   VALUES (2, 2, $1::date - 30, now(), 'backdated row older than the whole candidate') RETURNING id::text`, [sel.oldestDate])).rows[0].id;

// What a naive range delete WOULD do (measured inside a transaction that is rolled back)
await c.query("BEGIN");
const naive = await c.query(`DELETE FROM public.attendance_records WHERE attendance_date < $1::date RETURNING id::text`, [manifest.boundary.endDayExclusive]);
await c.query("ROLLBACK");
const naiveIds = new Set(naive.rows.map((r) => r.id));
rec.measure("naive_range_delete_would_remove", naive.rowCount);
rec.check("naive range delete would destroy the new in-range row (not archived)", true, naiveIds.has(newInRange));
rec.check("naive range delete would destroy the backdated row (not archived)", true, naiveIds.has(backdated));
rec.check("naive range delete would destroy the edited row (archived copy stale)", true, naiveIds.has(changedPk));

// ---- exact deletion ----
let totals = { requested: 0, deleted: 0, drifted: 0, held: 0, missing: 0 };
const td = now();
for (const b of rootBatches(ctx, 2_000)) {
  const r = (await deleteBatch(c, ctx, expandBatch(ctx, b)))[table]!;
  totals = { requested: totals.requested + r.requested, deleted: totals.deleted + r.deleted, drifted: totals.drifted + r.drifted, held: totals.held + r.held, missing: totals.missing + r.missing };
}
rec.measure("delete_ms", Math.round(ms(td)));
rec.measure("delete_totals", totals);

const exists = async (id: string) => (await c.query(`SELECT count(*)::int n FROM public.attendance_records WHERE id = $1`, [id])).rows[0].n === 1;
rec.check("unchanged frozen rows deleted (frozen − changed − app-deleted)", keys.length - 2, totals.deleted);
rec.check("changed candidate NOT deleted (drifted)", [true, 1], [await exists(changedPk), totals.drifted]);
rec.check("row deleted by the app is reported as missing", 1, totals.missing);
rec.check("new row inside archived range preserved", true, await exists(newInRange));
rec.check("backdated row preserved", true, await exists(backdated));
rec.check("reconciliation: requested = deleted + drifted + held + missing", totals.requested, totals.deleted + totals.drifted + totals.held + totals.missing);
const leftover = (await c.query(`SELECT count(*)::int n FROM public.attendance_records WHERE id = ANY($1::bigint[])`, [keys.map((k) => k.pk)])).rows[0].n;
rec.check("rows remaining from the frozen set = drifted only", 1, leftover);

// ---- fingerprint determinism + cost ----
const fpA = (await c.query(`SELECT ${FINGERPRINT("t")} fp FROM public.attendance_records t WHERE id = $1`, [changedPk])).rows[0].fp;
const fpB = (await c.query(`SELECT ${FINGERPRINT("t")} fp FROM public.attendance_records t WHERE id = $1`, [changedPk])).rows[0].fp;
rec.check("fingerprint deterministic for unchanged row", fpA, fpB);
await c.query(`SET TimeZone = 'Asia/Kolkata'`);
const fpTz = (await c.query(`SELECT ${FINGERPRINT("t")} fp FROM public.attendance_records t WHERE id = $1`, [changedPk])).rows[0].fp;
await c.query(`SET TimeZone = 'UTC'`);
rec.check("fingerprint CHANGES if session TimeZone differs (settings must be pinned)", true, fpTz !== fpA);
for (const [name, expr] of [["sha256", FINGERPRINT("t")], ["md5", FINGERPRINT_MD5("t")]] as const) {
  const tt = now();
  await c.query(`SELECT count(DISTINCT ${expr}) FROM public.attendance_records t`);
  rec.measure(`fingerprint_${name}_all_rows_ms`, Math.round(ms(tt)));
}
rec.measure("attendance_rows_fingerprinted", (await c.query(`SELECT count(*)::int n FROM public.attendance_records`)).rows[0].n);
await c.end();
rec.save();
