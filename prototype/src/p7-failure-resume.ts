/**
 * PROTOTYPE / SYNTHETIC DATA ONLY — P7 Failure / resume / idempotency (ADR §12).
 * For each crash point: crash worker A, prove duplicates are prevented, expire the lease,
 * resume with worker B, and reconcile every frozen row.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DBS, connect } from "./lib/db.ts";
import { buildContext, deleteBatch, expandBatch, NestedTransactionError, rootBatches } from "./lib/deleter.ts";
import { approveDeletion, createJob, CrashSignal, JobRunner, LeaseHeld, type CrashPoint } from "./lib/jobRunner.ts";
import { planGroup, type GroupSpec } from "./lib/group.ts";
import type { Manifest } from "./lib/archive.ts";
import { Recorder } from "./lib/results.ts";

const rec = new Recorder("p7-failure-resume", "P7 — Failure / resume");
const sqlDir = join(dirname(fileURLToPath(import.meta.url)), "..", "sql");

// fresh control plane
const admin = await connect("postgres", { pin: false });
await admin.query(`DROP DATABASE IF EXISTS ${DBS.control} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${DBS.control}`);
await admin.end();
const cp = await connect(DBS.control);
await cp.query(readFileSync(join(sqlDir, "control_plane.sql"), "utf8"));
const src = await connect(DBS.jalsa);

const spec: GroupSpec = {
  applicationId: "jalsa-synth", database: DBS.jalsa, root: "public.orders", dateColumn: "order_date",
  tables: ["public.orders", "public.order_items", "public.payments"], timeZone: "Asia/Kolkata", cutoffDay: "2025-09-30", target: 3_000,
};
const counts = async () => (await src.query(`SELECT (SELECT count(*) FROM orders)::int o, (SELECT count(*) FROM order_items)::int i, (SELECT count(*) FROM payments)::int p`)).rows[0] as { o: number; i: number; p: number };
const expire = (id: string) => cp.query(`UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [id]);
const status = async (id: string) => (await cp.query(`SELECT status, attempt FROM jobs WHERE id = $1`, [id])).rows[0] as { status: string; attempt: number };
const DELETE_PHASE: CrashPoint[] = ["before_deletion", "mid_deletion_in_txn", "mid_deletion_after_commit", "after_deletion", "during_deletion_verification"];
const POINTS: CrashPoint[] = ["before_export", "during_export", "after_export_before_checkpoint", "after_upload_checkpoint", "during_verification", ...DELETE_PHASE];

const matrix: Record<string, unknown> = {};
for (const point of POINTS) {
  const id = `P7-${point}`;
  const before = await counts();
  await createJob(cp, id, spec);
  const runA = (crashAt?: CrashPoint) => new JobRunner({ workerId: "worker-A", crashAt, batchSize: 100 }).run(id);
  let crashed = false;
  try {
    if (DELETE_PHASE.includes(point)) {
      rec.check(`${point}: pre-crash run reaches ready_for_deletion`, "ready_for_deletion", await runA());
      await approveDeletion(cp, id, "prototype-approver");
    }
    await runA(point);
  } catch (e) {
    if (!(e instanceof CrashSignal)) throw e;
    crashed = true;
  }
  const atCrash = await status(id);
  const afterCrash = await counts();
  const deletedAtCrash = before.o + before.i + before.p - (afterCrash.o + afterCrash.i + afterCrash.p);

  // duplicate prevention
  let dupCode = "";
  try { await createJob(cp, `${id}-dup`, spec); } catch (e) { dupCode = (e as { code?: string }).code ?? String(e); }
  let leaseBlocked = false;
  try { await new JobRunner({ workerId: "worker-B" }).run(id); } catch (e) { leaseBlocked = e instanceof LeaseHeld; }

  // resume with worker B after the lease expires
  await expire(id);
  const runB = () => new JobRunner({ workerId: "worker-B", batchSize: 100 }).run(id);
  let final = await runB();
  if (final === "ready_for_deletion") { await approveDeletion(cp, id, "prototype-approver"); final = await runB(); }
  const job = (await cp.query(`SELECT status, attempt, counts FROM jobs WHERE id = $1`, [id])).rows[0];
  const after = await counts();
  const totalDeleted = before.o + before.i + before.p - (after.o + after.i + after.p);
  const reportedDeleted = Object.values(job.counts as Record<string, { deleted: number }>).reduce((a, x) => a + (x.deleted ?? 0), 0);
  const retried = Object.values(job.counts as Record<string, { missing_on_retried_batches: number }>).reduce((a, x) => a + (x.missing_on_retried_batches ?? 0), 0);
  const orphans = (await src.query(`SELECT (SELECT count(*) FROM order_items i WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = i.order_id))::int
                                      + (SELECT count(*) FROM payments p WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = p.order_id))::int n`)).rows[0].n;
  const allReconcile = Object.values(job.counts as Record<string, { reconciles: boolean }>).every((x) => x.reconciles);
  matrix[point] = {
    crashed, stateAtCrash: atCrash.status, rowsDeletedAtCrash: deletedAtCrash,
    duplicateJobRejected: dupCode === "23505", secondWorkerBlockedByLease: leaseBlocked,
    finalStatus: job.status, exportAttempts: job.attempt, rowsDeletedTotal: totalDeleted,
    rowsCountedAsMissingOnRetriedBatches: retried, reconciles: allReconcile, orphans,
  };
  rec.check(`${point}: crash happened, duplicate job rejected, lease blocks 2nd worker`, [true, "23505", true], [crashed, dupCode, leaseBlocked]);
  rec.check(`${point}: resumed to completion, every table reconciles, no orphans`, ["completed", true, 0], [job.status, allReconcile, orphans]);
  rec.check(`${point}: rows removed from DB = rows the job reports deleted + rows its own crashed attempt deleted`, totalDeleted, reportedDeleted + retried);
}
rec.measure("failure_matrix", matrix);

// ---- kill switch ----
{
  const id = "P7-kill-switch";
  await createJob(cp, id, spec);
  await new JobRunner({ workerId: "A" }).run(id);
  await approveDeletion(cp, id, "prototype-approver");
  await cp.query(`UPDATE settings SET deletion_kill_switch = true`);
  const before = await counts();
  const st = await new JobRunner({ workerId: "A" }).run(id);
  const after = await counts();
  await cp.query(`UPDATE settings SET deletion_kill_switch = false`);
  rec.check("kill switch: job stops in requires_review and deletes 0 rows", ["requires_review", 0], [st, before.o + before.i + before.p - after.o - after.i - after.p]);
}

// ---- nested transaction guard (found by the P5 harness bug) ----
{
  const plan = await planGroup(src, { ...spec, target: 200 });
  const { selectCandidate } = await import("./lib/group.ts");
  const { exportGroup } = await import("./lib/archive.ts");
  const sel = await selectCandidate(src, plan);
  const ex = await exportGroup(src, plan, sel, "P7-nested", 1);
  const ctx = await buildContext(ex.dir, ex.manifest as Manifest, plan.schemas, plan.edges);
  const before = await counts();
  await src.query("BEGIN");
  let err: unknown = null;
  try { await deleteBatch(src, ctx, expandBatch(ctx, rootBatches(ctx, 50)[0]!)); } catch (e) { err = e; }
  await src.query("ROLLBACK").catch(() => {});
  const after = await counts();
  rec.check("deleteBatch refuses to run inside a caller's transaction and deletes nothing", [true, 0],
    [err instanceof NestedTransactionError, before.o + before.i + before.p - after.o - after.i - after.p]);
}
await src.end();
await cp.end();
rec.save();
