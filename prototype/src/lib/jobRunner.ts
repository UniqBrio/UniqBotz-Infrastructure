/**
 * PROTOTYPE / SYNTHETIC DATA ONLY.
 * Minimal job runner over the control-plane tables: leases + heartbeats, per-step checkpoints,
 * attempt-scoped exports, idempotent batched deletion, kill switch, and crash injection for P7.
 * States follow ADR §12 (queued → preparing → selecting → exporting → verifying → ready_for_deletion
 * → deletion_approved → deleting → verifying_deletion → completed[_with_exceptions]).
 */
import { readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type pg from "pg";
import { attemptDir, exportGroup, type Manifest } from "./archive.ts";
import { DBS, connect } from "./db.ts";
import { buildContext, deleteBatch, expandBatch, rootBatches } from "./deleter.ts";
import { planGroup, selectCandidate, type GroupSpec } from "./group.ts";
import { expectationFrom, verifyArchive, type ExpectedRecord, type VerificationResult } from "./verify.ts";

export type CrashPoint =
  | "before_export"
  | "during_export"
  | "after_export_before_checkpoint"
  | "after_upload_checkpoint"
  | "during_verification"
  | "before_deletion"
  | "mid_deletion_in_txn"
  | "mid_deletion_after_commit"
  | "after_deletion"
  | "during_deletion_verification";

export class CrashSignal extends Error {
  constructor(public point: CrashPoint) { super(`simulated worker crash at ${point}`); }
}
export class LeaseHeld extends Error {}
export class LeaseLost extends Error {}

export const TERMINAL = ["completed", "completed_with_exceptions", "failed", "cancelled", "requires_review"];

export interface RunnerOptions {
  workerId: string;
  crashAt?: CrashPoint;
  batchSize?: number;
  leaseSeconds?: number;
  verificationMaxAgeMinutes?: number;
  /** Test hook between verification and deletion (P8 schema change, late data). */
  beforeDeletionGate?: (source: pg.Client) => Promise<void>;
  /** Test hook after selection, before the freeze/export snapshot (late data). */
  beforeFreeze?: (source: pg.Client, selection: { oldestDate: string; boundaryDate: string }) => Promise<void>;
}

interface JobRow {
  id: string;
  status: string;
  attempt: number;
  spec: GroupSpec;
  selection: { endDayExclusive: string; oldestDate: string; boundaryDate: string; totalSelected: number } | null;
  manifest: { dir: string; expected: ExpectedRecord } | null;
  verification: (VerificationResult & { at: string }) | null;
  schema_hash: string | null;
  graph_hash: string | null;
  counts: Record<string, unknown>;
}

export async function createJob(cp: pg.Client, id: string, spec: GroupSpec) {
  await cp.query(
    `INSERT INTO jobs (id, application_id, table_group, status, spec) VALUES ($1, $2, $3, 'queued', $4)`,
    [id, spec.applicationId, spec.tables.slice().sort().join("+"), JSON.stringify(spec)],
  );
  await event(cp, id, "created", { spec });
}

export async function approveDeletion(cp: pg.Client, id: string, by: string) {
  const r = await cp.query(`UPDATE jobs SET status = 'deletion_approved', approved_by = $2, updated_at = now()
                            WHERE id = $1 AND status = 'ready_for_deletion'`, [id, by]);
  if (r.rowCount !== 1) throw new Error("job is not ready_for_deletion");
  await event(cp, id, "deletion_approved", { by });
}

async function event(cp: pg.Client, id: string, name: string, detail: unknown = {}) {
  await cp.query(`INSERT INTO job_events (job_id, event, detail) VALUES ($1, $2, $3)`, [id, name, JSON.stringify(detail)]);
}

export class JobRunner {
  private cp!: pg.Client;
  private src!: pg.Client;
  constructor(private o: RunnerOptions) {}

  private crash(point: CrashPoint) {
    if (this.o.crashAt === point) throw new CrashSignal(point);
  }

  private async claim(id: string): Promise<JobRow> {
    const r = await this.cp.query(
      `UPDATE jobs SET lease_owner = $2, lease_expires_at = now() + make_interval(secs => $3), updated_at = now()
       WHERE id = $1 AND (lease_owner IS NULL OR lease_owner = $2 OR lease_expires_at < now()) RETURNING *`,
      [id, this.o.workerId, this.o.leaseSeconds ?? 30],
    );
    if (r.rowCount !== 1) throw new LeaseHeld(`job ${id} is leased by another worker`);
    return r.rows[0] as JobRow;
  }

  private async heartbeat(id: string) {
    const r = await this.cp.query(
      `UPDATE jobs SET lease_expires_at = now() + make_interval(secs => $3) WHERE id = $1 AND lease_owner = $2`,
      [id, this.o.workerId, this.o.leaseSeconds ?? 30]);
    if (r.rowCount !== 1) throw new LeaseLost(`lease lost for ${id}`);
  }

  /** Every state write is conditional on still owning the lease. */
  private async set(id: string, fields: Record<string, unknown>) {
    const keys = Object.keys(fields);
    const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(", ");
    const vals = keys.map((k) => (typeof fields[k] === "object" && fields[k] !== null ? JSON.stringify(fields[k]) : fields[k]));
    const r = await this.cp.query(`UPDATE jobs SET ${sets}, updated_at = now() WHERE id = $1 AND lease_owner = $2`, [id, this.o.workerId, ...vals]);
    if (r.rowCount !== 1) throw new LeaseLost(`lease lost for ${id}`);
    if (fields.status) await event(this.cp, id, `status:${fields.status}`, {});
  }

  async run(id: string): Promise<string> {
    this.cp = await connect(DBS.control);
    let job: JobRow;
    try {
      job = await this.claim(id);
      this.src = await connect(job.spec.database);
      // A dropped connection must surface as a failed query, never crash the process (found in P7).
      this.src.on("error", () => {});
      this.cp.on("error", () => {});
      for (;;) {
        job = (await this.cp.query(`SELECT * FROM jobs WHERE id = $1`, [id])).rows[0] as JobRow;
        if (TERMINAL.includes(job.status) || job.status === "ready_for_deletion") return job.status;
        await this.heartbeat(id);
        await this.step(job);
      }
    } finally {
      await this.src?.end().catch(() => {});
      await this.cp.end().catch(() => {});
    }
  }

  private async step(job: JobRow) {
    const id = job.id;
    switch (job.status) {
      case "queued":
        return this.set(id, { status: "preparing" });

      case "preparing": {
        const plan = await planGroup(this.src, job.spec);
        if (plan.blocking.length) {
          await event(this.cp, id, "preflight_blocked", plan.blocking);
          return this.set(id, { status: "failed", counts: { reason: "preflight", blocking: plan.blocking, deleted: 0 } });
        }
        return this.set(id, { status: "selecting", schema_hash: plan.schemaHash, graph_hash: plan.graphHash });
      }

      case "selecting": {
        const plan = await planGroup(this.src, job.spec);
        const sel = await selectCandidate(this.src, plan);
        if (!sel.reachedTarget) return this.set(id, { status: "cancelled", counts: { reason: "target_not_reached", eligible: sel.totalSelected, deleted: 0 } });
        return this.set(id, { status: "exporting", selection: { endDayExclusive: sel.endDayExclusive, oldestDate: sel.oldestDate, boundaryDate: sel.boundaryDate, totalSelected: sel.totalSelected } });
      }

      case "exporting": {
        this.crash("before_export");
        const attempt = job.attempt + 1;
        await this.set(id, { attempt });
        // discard any previous partial attempt (never mixed with a new snapshot)
        for (let a = 1; a < attempt; a++) rmSync(attemptDir(id, a), { recursive: true, force: true });
        const plan = await planGroup(this.src, job.spec);
        const sel = await selectCandidate(this.src, plan); // same days: selection is recomputed read-only
        if (sel.boundaryDate !== job.selection!.boundaryDate) {
          await event(this.cp, id, "selection_changed_on_retry", { was: job.selection, now: sel.boundaryDate });
        }
        if (this.o.beforeFreeze) await this.o.beforeFreeze(this.src, job.selection!);
        let first = true;
        const res = await exportGroup(this.src, plan, sel, id, attempt, {
          betweenTables: async () => { if (first) { first = false; this.crash("during_export"); } },
        });
        this.crash("after_export_before_checkpoint");
        await this.set(id, { manifest: { dir: res.dir, expected: expectationFrom(res.manifest, res.manifestSha256) }, manifest_sha256: res.manifestSha256,
          selection: { endDayExclusive: res.selection.endDayExclusive, oldestDate: res.selection.oldestDate, boundaryDate: res.selection.boundaryDate, totalSelected: res.selection.totalSelected, previewBoundary: sel.boundaryDate }, status: "verifying" });
        this.crash("after_upload_checkpoint");
        return;
      }

      case "verifying": {
        const v = await verifyArchive(job.manifest!.dir, job.manifest!.expected);
        this.crash("during_verification");
        await this.set(id, { verification: { ...v, at: new Date().toISOString() } });
        if (!v.passed) return this.set(id, { status: "failed", counts: { reason: "verification_failed", deleted: 0 } });
        return this.set(id, { status: "ready_for_deletion" });
      }

      case "deletion_approved": {
        // pre-deletion gate: verification passed + fresh, schema & FK graph unchanged, kill switch off
        if (this.o.beforeDeletionGate) await this.o.beforeDeletionGate(this.src);
        const v = job.verification;
        if (!v || !v.passed) return this.set(id, { status: "failed", counts: { reason: "not_verified", deleted: 0 } });
        const age = (Date.now() - new Date(v.at).getTime()) / 60000;
        if (age > (this.o.verificationMaxAgeMinutes ?? 60 * 24)) return this.set(id, { status: "verifying" });
        const plan = await planGroup(this.src, job.spec);
        if (plan.schemaHash !== job.schema_hash || plan.graphHash !== job.graph_hash) {
          await event(this.cp, id, "schema_or_graph_drift", { was: job.schema_hash, now: plan.schemaHash });
          return this.set(id, { status: "requires_review", counts: { reason: "schema_or_graph_changed", deleted: 0 } });
        }
        await this.set(id, { status: "deleting" });
        return;
      }

      case "deleting": {
        this.crash("before_deletion");
        const plan = await planGroup(this.src, job.spec);
        if (plan.schemaHash !== job.schema_hash || plan.graphHash !== job.graph_hash) {
          await event(this.cp, id, "schema_or_graph_drift_during_delete", {});
          return this.set(id, { status: "requires_review", counts: { reason: "schema_or_graph_changed_during_delete" } });
        }
        const manifest = JSON.parse(readFileSync(`${job.manifest!.dir}/manifest.json`, "utf8")) as Manifest;
        const ctx = await buildContext(dirname(`${job.manifest!.dir}/manifest.json`), manifest, plan.schemas, plan.edges);
        const batches = rootBatches(ctx, this.o.batchSize ?? 500);
        const done = new Set((await this.cp.query(`SELECT DISTINCT batch_no FROM job_batches WHERE job_id = $1 AND state = 'done'`, [id])).rows.map((r) => r.batch_no as number));
        const half = Math.floor(batches.length / 2);
        for (let i = 0; i < batches.length; i++) {
          if (done.has(i)) continue;
          const kill = (await this.cp.query(`SELECT deletion_kill_switch k FROM settings WHERE id = 1`)).rows[0].k;
          if (kill) {
            await event(this.cp, id, "kill_switch_stop", { atBatch: i });
            return this.set(id, { status: "requires_review", counts: { reason: "kill_switch" } });
          }
          await this.heartbeat(id);
          const byTable = expandBatch(ctx, batches[i]!);
          for (const t of manifest.deleteOrder) {
            await this.cp.query(
              `INSERT INTO job_batches (job_id, table_name, batch_no, requested, state) VALUES ($1, $2, $3, $4, 'started')
               ON CONFLICT (job_id, table_name, batch_no) DO UPDATE SET attempts = job_batches.attempts + 1, started_at = clock_timestamp()`,
              [id, t, i, byTable[t]?.length ?? 0]);
          }
          const out = await deleteBatch(this.src, ctx, byTable, {
            beforeCommit: async () => {
              if (i === half && this.o.crashAt === "mid_deletion_in_txn") {
                // simulate the worker dying mid-transaction: drop the socket; the server rolls back
                (this.src as unknown as { connection: { stream: { destroy(): void } } }).connection.stream.destroy();
                throw new CrashSignal("mid_deletion_in_txn");
              }
            },
          });
          if (i === half) this.crash("mid_deletion_after_commit");
          for (const [t, o] of Object.entries(out)) {
            await this.cp.query(
              `UPDATE job_batches SET state = 'done', deleted = $4, drifted = $5, missing = $6, finished_at = clock_timestamp(),
                 requested = $7 WHERE job_id = $1 AND table_name = $2 AND batch_no = $3`,
              [id, t, i, o.deleted, o.drifted + o.held, o.missing, o.requested]);
          }
        }
        this.crash("after_deletion");
        return this.set(id, { status: "verifying_deletion" });
      }

      case "verifying_deletion": {
        const manifest = JSON.parse(readFileSync(`${job.manifest!.dir}/manifest.json`, "utf8")) as Manifest;
        const plan = await planGroup(this.src, job.spec);
        const ctx = await buildContext(job.manifest!.dir, manifest, plan.schemas, plan.edges);
        const sums = (await this.cp.query(
          `SELECT table_name, sum(requested)::int requested, sum(deleted)::int deleted, sum(drifted)::int skipped, sum(missing)::int missing,
                  sum(CASE WHEN attempts > 1 THEN missing ELSE 0 END)::int missing_on_retried_batches,
                  bool_and(state = 'done') all_done
           FROM job_batches WHERE job_id = $1 GROUP BY table_name`, [id])).rows;
        this.crash("during_deletion_verification");
        const report: Record<string, unknown> = {};
        let exceptions = false;
        let ok = true;
        for (const s of sums) {
          const s2 = plan.schemas[s.table_name]!;
          const pk = s2.primaryKey[0]!;
          const pkType = s2.columns.find((x) => x.name === pk)!.type;
          const stillPresent = Number((await this.src.query(
            `SELECT count(*) n FROM ${s.table_name} WHERE ${pk} = ANY($1::${pkType}[])`, [ctx.keys[s.table_name]!.map((k) => k.pk)])).rows[0].n);
          const frozen = manifest.tables[s.table_name]!.rows;
          const reconciles = s.all_done && s.requested === frozen && s.deleted + s.skipped + s.missing === frozen && stillPresent === s.skipped;
          ok &&= reconciles;
          if (s.skipped > 0) exceptions = true;
          report[s.table_name] = { frozen, ...s, stillPresent, reconciles };
        }
        await event(this.cp, id, "deletion_verified", report);
        return this.set(id, { counts: report, status: ok ? (exceptions ? "completed_with_exceptions" : "completed") : "requires_review" });
      }

      default:
        throw new Error(`unhandled status ${job.status}`);
    }
  }
}
