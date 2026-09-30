/**
 * PROTOTYPE / SYNTHETIC DATA ONLY — Late / backdated records during a job (ADR §4, attack #6/#7).
 * Variant B (the race): changes AFTER freeze + verification, BEFORE deletion.
 * Variant A: changes AFTER selection, BEFORE the freeze snapshot.
 */
import { readFileSync } from "node:fs";
import { DBS, connect } from "./lib/db.ts";
import { approveDeletion, createJob, JobRunner } from "./lib/jobRunner.ts";
import type { GroupSpec } from "./lib/group.ts";
import { Recorder } from "./lib/results.ts";

const rec = new Recorder("late-data", "Late / backdated records during a job");
const src = await connect(DBS.rosifit);
const cp = await connect(DBS.control);
const spec: GroupSpec = { applicationId: "rosifit-synth", database: DBS.rosifit, root: "public.attendance_records", dateColumn: "attendance_date",
  tables: ["public.attendance_records"], timeZone: "Asia/Kolkata", cutoffDay: "2025-09-30", target: 20_000 };
const exists = async (id: string) => (await src.query(`SELECT count(*)::int n FROM public.attendance_records WHERE id = $1`, [id])).rows[0].n === 1;
const insert = async (date: string, note: string) => (await src.query(
  `INSERT INTO public.attendance_records (member_id, course_id, attendance_date, created_at, note) VALUES (3, 3, $1::date, now(), $2) RETURNING id::text`, [date, note])).rows[0].id as string;

// ---------------- Variant B: the race ----------------
{
  const id = `LATE-B-${Date.now()}`;
  await createJob(cp, id, spec);
  rec.check("B: job reaches ready_for_deletion (selected, frozen, exported, verified)", "ready_for_deletion", await new JobRunner({ workerId: "A" }).run(id));
  const job = (await cp.query(`SELECT selection, manifest FROM jobs WHERE id = $1`, [id])).rows[0];
  const keys = readFileSync(`${job.manifest.dir}/keys/attendance_records.csv.gz`);
  const { gunzipSync } = await import("node:zlib");
  const frozen = gunzipSync(keys).toString().trim().split("\n").slice(1).map((l) => l.split(",")[0]!);
  const unchangedPk = frozen[100]!;
  const modifiedPk = frozen[200]!;
  const newInRange = await insert(job.selection.boundaryDate, "late insert inside archived range");
  const backdated = await insert("2021-06-01", "backdated far before any archived day");
  await src.query(`UPDATE public.attendance_records SET note = 'corrected after freeze', updated_at = now() WHERE id = $1`, [modifiedPk]);
  await approveDeletion(cp, id, "prototype-approver");
  const final = await new JobRunner({ workerId: "A", batchSize: 2000 }).run(id);
  const counts = (await cp.query(`SELECT counts FROM jobs WHERE id = $1`, [id])).rows[0].counts["public.attendance_records"];
  rec.measure("variant_B_counts", counts);
  rec.check("B: new in-range record → preserved", true, await exists(newInRange));
  rec.check("B: backdated record → preserved", true, await exists(backdated));
  rec.check("B: modified candidate → skipped (still present, counted as drifted)", [true, 1], [await exists(modifiedPk), counts.skipped]);
  rec.check("B: unchanged verified candidate → deleted", false, await exists(unchangedPk));
  rec.check("B: job completes with exceptions (drift reported), reconciliation holds", ["completed_with_exceptions", true], [final, counts.reconciles]);

  // the next job starts at the actual oldest eligible date → picks up the backdated straggler (ADR D-05)
  const id2 = `LATE-B2-${Date.now()}`;
  await createJob(cp, id2, { ...spec, target: 1 });
  await new JobRunner({ workerId: "A" }).run(id2);
  const sel2 = (await cp.query(`SELECT selection FROM jobs WHERE id = $1`, [id2])).rows[0].selection;
  rec.check("next job's oldest day is the backdated straggler's day (2021-06-01), not boundary + 1", "2021-06-01", sel2.oldestDate);
  await cp.query(`UPDATE jobs SET status = 'cancelled' WHERE id = $1`, [id2]);
}

// ---------------- Variant A: changes between selection and freeze ----------------
{
  const id = `LATE-A-${Date.now()}`;
  let newInRange = "", backdated = "";
  await createJob(cp, id, spec);
  const st = await new JobRunner({
    workerId: "A",
    beforeFreeze: async (s, sel) => {
      newInRange = (await s.query(`INSERT INTO public.attendance_records (member_id, course_id, attendance_date, created_at, note) VALUES (4, 4, $1::date, now(), 'inserted between selection and freeze') RETURNING id::text`, [sel.boundaryDate])).rows[0].id;
      backdated = (await s.query(`INSERT INTO public.attendance_records (member_id, course_id, attendance_date, created_at, note) VALUES (4, 4, $1::date - 3, now(), 'backdated between selection and freeze') RETURNING id::text`, [sel.oldestDate])).rows[0].id;
    },
  }).run(id);
  const job = (await cp.query(`SELECT manifest FROM jobs WHERE id = $1`, [id])).rows[0];
  const { gunzipSync } = await import("node:zlib");
  const frozen = new Set(gunzipSync(readFileSync(`${job.manifest.dir}/keys/attendance_records.csv.gz`)).toString().trim().split("\n").slice(1).map((l) => l.split(",")[0]!));
  rec.check("A: a row inserted inside the selected days BEFORE the freeze is frozen, archived and verified (whole day stays whole)", ["ready_for_deletion", true], [st, frozen.has(newInRange)]);
  rec.check("A: a row backdated before the first selected day BEFORE the freeze is also inside the snapshot predicate", true, frozen.has(backdated));
  rec.note("Variant A rows are archived and verified before deletion, so deleting them is safe. Only rows arriving AFTER the freeze are protected by exclusion; both paths satisfy invariant I-1.");
  await cp.query(`UPDATE jobs SET status = 'cancelled' WHERE id = $1`, [id]);
}
await src.end();
await cp.end();
rec.save();
