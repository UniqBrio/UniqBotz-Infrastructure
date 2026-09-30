/**
 * PROTOTYPE / SYNTHETIC DATA ONLY — P8 Schema change during a job (ADR §2 A-2, §5.6, attack #11).
 * A job is exported + verified, then the table's schema changes before deletion.
 * Expected: detection, requires_review, DELETE = 0.
 */
import { DBS, connect } from "./lib/db.ts";
import { approveDeletion, createJob, JobRunner } from "./lib/jobRunner.ts";
import { FINGERPRINT } from "./lib/schema.ts";
import { Recorder } from "./lib/results.ts";

const rec = new Recorder("p8-schema-change", "P8 — Schema change");
const src = await connect(DBS.rosifit);
const cp = await connect(DBS.control);

const CHANGES: Record<string, string> = {
  added_column: `ALTER TABLE %T ADD COLUMN source text`,
  removed_column: `ALTER TABLE %T DROP COLUMN note`,
  renamed_column: `ALTER TABLE %T RENAME COLUMN note TO remark`,
  changed_type: `ALTER TABLE %T ALTER COLUMN course_id TYPE bigint`,
  changed_constraint: `ALTER TABLE %T ADD CONSTRAINT course_positive CHECK (course_id > 0)`,
  changed_fk: `ALTER TABLE %T ADD CONSTRAINT lab_member_fk FOREIGN KEY (member_id) REFERENCES public.members(id) ON DELETE CASCADE`,
};

const matrix: Record<string, unknown> = {};
for (const [name, ddl] of Object.entries(CHANGES)) {
  const table = `public.schema_lab_${name}`;
  await src.query(`DROP TABLE IF EXISTS ${table}`);
  await src.query(`CREATE TABLE ${table} AS SELECT * FROM public.attendance_records WHERE attendance_date IS NOT NULL ORDER BY attendance_date, id LIMIT 20000`);
  await src.query(`ALTER TABLE ${table} ADD PRIMARY KEY (id); CREATE INDEX ON ${table} (attendance_date); ANALYZE ${table}`);
  const id = `P8-${name}`;
  await cp.query(`DELETE FROM job_batches WHERE job_id = $1`, [id]);
  await cp.query(`DELETE FROM job_events WHERE job_id = $1`, [id]);
  await cp.query(`DELETE FROM jobs WHERE id = $1`, [id]);
  await createJob(cp, id, { applicationId: "rosifit-synth", database: DBS.rosifit, root: table, dateColumn: "attendance_date",
    tables: [table], timeZone: "Asia/Kolkata", cutoffDay: "2025-09-30", target: 5_000 });
  const st1 = await new JobRunner({ workerId: "A" }).run(id);
  const before = Number((await src.query(`SELECT count(*) n FROM ${table}`)).rows[0].n);

  // counterfactual: how many frozen rows would a fingerprint-only guard still delete after this change?
  const job = (await cp.query(`SELECT manifest FROM jobs WHERE id = $1`, [id])).rows[0];
  const { buildContext } = await import("./lib/deleter.ts");
  const { planGroup } = await import("./lib/group.ts");
  const { readFileSync } = await import("node:fs");
  const manifest = JSON.parse(readFileSync(`${job.manifest.dir}/manifest.json`, "utf8"));
  const planNow = await planGroup(src, { applicationId: "x", database: DBS.rosifit, root: table, dateColumn: "attendance_date", tables: [table], timeZone: "Asia/Kolkata", cutoffDay: "2025-09-30", target: 1 });
  const ctx = await buildContext(job.manifest.dir, manifest, planNow.schemas, planNow.edges);
  await src.query(ddl.replace("%T", table));
  const keys = ctx.keys[table]!;
  const stillMatching = Number((await src.query(
    `WITH m(pk, fp) AS (SELECT * FROM unnest($1::text[], $2::text[]))
     SELECT count(*) n FROM ${table} t JOIN m ON t.id = m.pk::bigint AND ${FINGERPRINT("t")} = m.fp`,
    [keys.map((k) => k.pk), keys.map((k) => k.fp)])).rows[0].n);

  await approveDeletion(cp, id, "prototype-approver");
  const st2 = await new JobRunner({ workerId: "A" }).run(id);
  const after = Number((await src.query(`SELECT count(*) n FROM ${table}`)).rows[0].n);
  const ev = (await cp.query(`SELECT event FROM job_events WHERE job_id = $1 AND event LIKE 'schema%'`, [id])).rows.map((r) => r.event);
  matrix[name] = { beforeChange: st1, finalStatus: st2, detectedBy: ev, rowsDeleted: before - after, frozenRows: keys.length, fingerprintOnlyWouldStillDelete: stillMatching };
  rec.check(`${name}: detected → requires_review, DELETE = 0`, ["ready_for_deletion", "requires_review", 0], [st1, st2, before - after]);
  await src.query(`DROP TABLE ${table}`);
}
rec.measure("schema_change_matrix", matrix);
const guardBlind = Object.entries(matrix).filter(([, v]) => (v as { fingerprintOnlyWouldStillDelete: number }).fingerprintOnlyWouldStillDelete > 0).map(([k]) => k);
rec.measure("changes_invisible_to_row_fingerprint_alone", guardBlind);
rec.check("row fingerprint alone misses rename / type / constraint changes → schema hash is REQUIRED", true, guardBlind.includes("renamed_column") && guardBlind.includes("changed_type"));

// ---- DDL arriving WHILE an export snapshot is open ----
const exp = await connect(DBS.rosifit);
const ddl = await connect(DBS.rosifit);
const app = await connect(DBS.rosifit);
await exp.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
await exp.query(`SELECT count(*) FROM public.attendance_records`); // holds ACCESS SHARE until commit
let ddlErr = "";
try { await ddl.query(`SET lock_timeout = '1s'; ALTER TABLE public.attendance_records ADD COLUMN probe text`); } catch (e) { ddlErr = (e as { code?: string }).code ?? String(e); }
rec.check("DDL with lock_timeout fails fast while an export snapshot is open (55P03)", "55P03", ddlErr);
// DDL WITHOUT lock_timeout queues and blocks ordinary application reads behind it
await ddl.query(`SET lock_timeout = 0`);
const pendingDdl = ddl.query(`ALTER TABLE public.attendance_records ADD COLUMN probe2 text`).catch((e) => e);
await new Promise((r) => setTimeout(r, 300));
let appErr = "";
const t0 = Date.now();
try { await app.query(`SET statement_timeout = '2s'; SELECT count(*) FROM public.attendance_records WHERE id < 100`); } catch (e) { appErr = (e as { code?: string }).code ?? String(e); }
rec.check("an app read queued behind the waiting DDL is blocked (statement timeout 57014)", "57014", appErr);
rec.measure("app_read_blocked_ms", Date.now() - t0);
await exp.query("COMMIT");
await pendingDdl;
await ddl.query(`ALTER TABLE public.attendance_records DROP COLUMN IF EXISTS probe2`);
await Promise.all([exp.end(), ddl.end(), app.end(), src.end(), cp.end()]);
rec.note("A long export snapshot plus an application migration without lock_timeout stalls application traffic on that table. Exports must be short, and schema migrations should use lock_timeout.");
rec.save();
