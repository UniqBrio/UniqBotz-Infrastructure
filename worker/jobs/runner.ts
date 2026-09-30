import type pg from "pg";
import { audit } from "../audit/audit";
import type { WorkerConfig } from "../config";
import { openConnection, qi } from "../connection/connect";
import type { SecretResolver } from "../connection/secrets";
import { formatById } from "../archive/format";
import { freezeAndExport, TargetNotReachedError } from "../archive/exporter";
import type { ArchiveStore } from "../archive/store";
import { selectCandidate } from "../candidates/selection";
import { loadApplication, loadSettings } from "../controlplane/repository";
import { buildBatches, deleteBatch, type TableOutcome } from "../deletion/batch";
import { evaluateDeletionGate } from "../deletion/gate";
import { planGroup, type GroupPlan, type GroupSpec } from "../retention/group";
import { acquireLease, heartbeat, LeaseLostError, releaseLease } from "../recovery/lease";
import { decideRetry } from "../recovery/retry";
import { runVerificationGate, type ExpectedArchive } from "../verification/gate";
import { loadCandidates, saveCandidateChunk, toMaps } from "./candidates";
import { CrashSignal, type CrashPoint } from "./faults";
import { DELETION_PHASE, TERMINAL_STATUSES, type JobMode, type JobStatus } from "./states";

export interface RunnerDeps {
  cp: pg.Client;
  secrets: SecretResolver;
  store: ArchiveStore;
  config: WorkerConfig;
  openScratch: () => Promise<pg.Client>;
  /** TEST ONLY. */
  faults?: { at?: CrashPoint };
  /** TEST ONLY hooks to simulate concurrent application activity. */
  hooks?: {
    beforeFreeze?: (source: pg.Client) => Promise<void>;
    beforeDeletionGate?: (source: pg.Client) => Promise<void>;
    afterDeletionBatch?: (batchNo: number) => Promise<void>;
  };
}

interface JobRow {
  id: string;
  application_id: string;
  group_root: string;
  mode: JobMode;
  status: JobStatus;
  resume_status: JobStatus | null;
  attempt: number;
  retry_count: number;
  next_retry_at: string | null;
  spec: GroupSpec;
  schema_hash: string | null;
  graph_hash: string | null;
}

export interface RunOutcome {
  status: JobStatus;
  deletionBlocked?: string[];
}

export class JobRunner {
  private src: pg.Client | null = null;
  private environment: "synthetic" | "staging" | "production" = "production";
  constructor(private d: RunnerDeps) {}

  private crash(p: CrashPoint) {
    if (this.d.faults?.at === p) throw new CrashSignal(p);
  }
  private lease(id: string) {
    return `job:${id}`;
  }
  private async job(id: string): Promise<JobRow> {
    return (await this.d.cp.query(`SELECT * FROM control.archive_jobs WHERE id = $1`, [id])).rows[0] as JobRow;
  }
  private async set(id: string, fields: Record<string, unknown>) {
    await heartbeat(this.d.cp, this.lease(id), this.d.config.workerId, this.d.config.leaseSeconds); // never write without the lease
    const keys = Object.keys(fields);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
    const vals = keys.map((k) => (fields[k] !== null && typeof fields[k] === "object" ? JSON.stringify(fields[k]) : fields[k]));
    await this.d.cp.query(`UPDATE control.archive_jobs SET ${sets}, updated_at = now() WHERE id = $1`, [id, ...vals]);
  }
  private async source(job: JobRow): Promise<pg.Client> {
    if (this.src) return this.src;
    const app = await loadApplication(this.d.cp, job.application_id);
    this.environment = app.environment;
    if (!app.connections.archive) throw new Error("application has no archive connection");
    this.src = await openConnection(app.connections.archive, this.d.secrets, { applicationName: "uniqbotz-archive-worker" });
    return this.src;
  }
  private async plan(job: JobRow): Promise<GroupPlan> {
    return planGroup(await this.source(job), job.spec);
  }

  async run(id: string): Promise<RunOutcome> {
    if (!(await this.job(id))) throw new Error(`unknown job ${id}`);
    const { takeover } = await acquireLease(this.d.cp, this.lease(id), this.d.config.workerId, this.d.config.leaseSeconds);
    let job = await this.job(id);
    let crashed = false;
    if (takeover) await audit(this.d.cp, { action: "lease_takeover", result: "info", applicationId: job.application_id, jobId: id, detail: { from: takeover, to: this.d.config.workerId, status: job.status } });
    try {
      for (let guard = 0; guard < 1000; guard++) {
        job = await this.job(id);
        if (TERMINAL_STATUSES.includes(job.status) || job.status === "ready_for_deletion") return { status: job.status };
        if (job.status === "waiting_retry") {
          if (job.next_retry_at && new Date(job.next_retry_at) > new Date()) return { status: job.status };
          await this.set(id, { status: job.resume_status, resume_status: null, next_retry_at: null });
          await audit(this.d.cp, { action: "job_resumed", result: "info", applicationId: job.application_id, jobId: id, detail: { status: job.resume_status } });
          continue;
        }
        try {
          const blocked = await this.step(job);
          if (blocked) return { status: (await this.job(id)).status, deletionBlocked: blocked };
        } catch (e) {
          if (e instanceof CrashSignal || e instanceof LeaseLostError) { crashed = e instanceof CrashSignal; throw e; }
          await this.src?.end().catch(() => {});
          this.src = null;
          const decision = decideRetry(e, job.retry_count);
          const message = String((e as Error).message ?? e).slice(0, 500);
          if (decision.retry) {
            await this.set(id, { status: "waiting_retry", resume_status: job.status, retry_count: job.retry_count + 1,
              next_retry_at: new Date(Date.now() + decision.delayMs).toISOString(), failure: { kind: decision.kind, message } });
            await audit(this.d.cp, { action: "job_retry_scheduled", result: "failure", applicationId: job.application_id, jobId: id, detail: { kind: decision.kind, message, delayMs: decision.delayMs, from: job.status } });
            return { status: "waiting_retry" };
          }
          const next: JobStatus = DELETION_PHASE.includes(job.status) ? "requires_review" : "failed";
          await this.set(id, { status: next, failure: { kind: decision.kind, message, at: job.status }, finished_at: new Date().toISOString() });
          await audit(this.d.cp, { action: next === "failed" ? "job_failed" : "job_requires_review", result: "failure", applicationId: job.application_id, jobId: id,
            detail: { kind: decision.kind, message, at: job.status, deleted: next === "failed" ? 0 : undefined } });
          return { status: next };
        }
      }
      throw new Error("runner loop guard exceeded");
    } finally {
      await this.src?.end().catch(() => {});
      this.src = null;
      // A real crash leaves its lease behind until it expires; simulate that faithfully.
      if (!crashed) await releaseLease(this.d.cp, this.lease(id), this.d.config.workerId).catch(() => {});
    }
  }

  /** Returns blocking reasons when deletion was refused; otherwise undefined. */
  private async step(job: JobRow): Promise<string[] | undefined> {
    const id = job.id;
    const a = { applicationId: job.application_id, jobId: id, tableName: job.group_root };
    switch (job.status) {
      case "queued":
        await this.set(id, { status: "preparing" });
        return;

      case "preparing": {
        const plan = await this.plan(job);
        if (plan.blocking.length) {
          await this.set(id, { status: "failed", failure: { reason: "preflight", blocking: plan.blocking, deleted: 0 }, finished_at: new Date().toISOString() });
          await audit(this.d.cp, { ...a, action: "job_failed", result: "blocked", detail: { preflight: plan.blocking, deleted: 0 } });
          return;
        }
        await this.d.cp.query(`DELETE FROM control.archive_job_tables WHERE job_id = $1`, [id]);
        for (const t of plan.spec.tables) {
          await this.d.cp.query(
            `INSERT INTO control.archive_job_tables (job_id, table_name, role, parent_table, parent_fk_column, delete_order) VALUES ($1,$2,$3,$4,$5,$6)`,
            [id, t, t === plan.spec.root ? "root" : "child", plan.links[t]?.parent ?? null, plan.links[t]?.childColumns[0] ?? null, plan.deleteOrder.indexOf(t)]);
        }
        await this.set(id, { status: "freezing", schema_hash: plan.schemaHash, graph_hash: plan.graphHash });
        return;
      }

      case "freezing":
      case "exporting": {
        this.crash("before_freeze");
        const attempt = job.attempt + 1;
        await this.set(id, { attempt, status: "exporting" });
        await this.d.cp.query(`DELETE FROM control.archive_job_candidates WHERE job_id = $1 AND attempt < $2`, [id, attempt]);
        for (let p = 1; p < attempt; p++) await this.d.store.removePrefix(`${job.application_id}/${id}/attempt-${p}`);
        const src = await this.source(job);
        if (this.d.hooks?.beforeFreeze) await this.d.hooks.beforeFreeze(src);
        const plan = await this.plan(job);
        if (plan.schemaHash !== job.schema_hash) {
          await this.set(id, { status: "failed", failure: { reason: "schema changed before freeze", deleted: 0 }, finished_at: new Date().toISOString() });
          await audit(this.d.cp, { ...a, action: "job_failed", result: "blocked", detail: { reason: "schema changed before freeze", deleted: 0 } });
          return;
        }
        const preview = await selectCandidate(src, plan); // read-only preview, only recorded for comparison
        let first = true;
        let res;
        try {
          res = await freezeAndExport(src, plan, preview, {
            jobId: id,
            attempt,
            store: this.d.store,
            format: formatById("csv.gz"),
            softwareVersion: this.d.config.softwareVersion,
            chunkSize: 2_000,
            onKeys: (table, chunkNo, keys) => saveCandidateChunk(this.d.cp, id, attempt, table, chunkNo, keys),
            betweenTables: async () => { if (first) { first = false; this.crash("during_export"); } },
          });
        } catch (e) {
          if (e instanceof TargetNotReachedError) {
            await this.set(id, { status: "cancelled", failure: { reason: "target_not_reached", deleted: 0 }, finished_at: new Date().toISOString() });
            await audit(this.d.cp, { ...a, action: "candidate_selected", result: "info", detail: { targetReached: false, deleted: 0 } });
            return;
          }
          throw e;
        }
        this.crash("after_export_before_checkpoint");
        const files: ExpectedArchive["files"] = { [res.schemaObject.key]: { bytes: res.schemaObject.bytes, sha256: res.schemaObject.sha256, rawSha256: "" } };
        for (const t of Object.values(res.manifest.tables)) {
          files[t.data.key] = { bytes: t.data.bytes, sha256: t.data.sha256, rawSha256: t.data.rawSha256 };
          files[t.keys.key] = { bytes: t.keys.bytes, sha256: t.keys.sha256, rawSha256: t.keys.rawSha256 };
        }
        await this.d.cp.query(
          `INSERT INTO control.archive_manifests (job_id, attempt, store_kind, store_uri, manifest_key, manifest_sha256, manifest, files)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (job_id, attempt) DO NOTHING`,
          [id, attempt, this.d.store.kind, this.d.store.uri(res.prefix), res.manifestKey, res.manifestSha256, JSON.stringify(res.manifest), JSON.stringify(files)]);
        for (const [t, mt] of Object.entries(res.manifest.tables)) {
          await this.d.cp.query(`UPDATE control.archive_job_tables SET candidate_rows = $3 WHERE job_id = $1 AND table_name = $2`, [id, t, mt.rows]);
        }
        const sel = res.selection;
        await this.set(id, { status: "verifying", selection: {
          oldestDate: sel.oldestDate, boundaryDate: sel.boundaryDate, endDayExclusive: sel.endDayExclusive, totalSelected: sel.totalSelected,
          totalBeforeFinalDay: sel.totalBeforeFinalDay, finalDayCount: sel.finalDayCount, totalsByTable: sel.totalsByTable, previewBoundary: preview.boundaryDate } });
        await audit(this.d.cp, { ...a, action: "candidates_frozen", result: "success", detail: { attempt, rows: sel.totalSelected, boundary: sel.boundaryDate, totalsByTable: sel.totalsByTable, snapshot: "REPEATABLE READ READ ONLY" } });
        await audit(this.d.cp, { ...a, action: "archive_created", result: "success", detail: { attempt, store: this.d.store.uri(res.prefix), manifestSha256: res.manifestSha256 } });
        this.crash("after_manifest_checkpoint");
        return;
      }

      case "verifying": {
        const m = (await this.d.cp.query(`SELECT * FROM control.archive_manifests WHERE job_id = $1 AND attempt = $2`, [id, job.attempt])).rows[0];
        const { keys, intact } = await loadCandidates(this.d.cp, id, job.attempt);
        const manifest = m.manifest;
        const plan = await this.plan(job);
        const expected: ExpectedArchive = {
          jobId: id, attempt: job.attempt, applicationId: job.application_id, manifestKey: m.manifest_key, manifestSha256: m.manifest_sha256,
          files: m.files, rowsByTable: Object.fromEntries(Object.entries(manifest.tables).map(([t, x]) => [t, (x as { rows: number }).rows])),
          candidateKeyDigests: Object.fromEntries(Object.entries(manifest.tables).map(([t, x]) => [t, (x as { keys: { rawSha256: string } }).keys.rawSha256])),
          schemaHash: job.schema_hash!, boundary: { firstDay: manifest.boundary.firstDay, lastDay: manifest.boundary.lastDay },
        };
        const g = await runVerificationGate({ store: this.d.store, format: formatById("csv.gz"), expected, currentSchemaHash: plan.schemaHash,
          controlPlaneCandidates: intact ? toMaps(keys) : {}, openScratch: this.d.openScratch, verifierVersion: this.d.config.softwareVersion });
        this.crash("during_verification");
        await this.d.cp.query(
          `INSERT INTO control.archive_verifications (job_id, attempt, verified, failed_stage, checks, verifier_version, duration_ms) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [id, job.attempt, g.verified, g.failedStage, JSON.stringify(g.checks), g.verifierVersion, Math.round(g.ms)]);
        if (!g.verified) {
          await this.set(id, { status: "failed", failure: { reason: "verification_failed", stage: g.failedStage, deleted: 0 }, finished_at: new Date().toISOString() });
          await audit(this.d.cp, { ...a, action: "archive_verification_failed", result: "failure", detail: { failedStage: g.failedStage, deleted: 0 } });
          return;
        }
        await this.set(id, { status: "ready_for_deletion" });
        await audit(this.d.cp, { ...a, action: "archive_verified", result: "success", detail: { stages: 6, checks: g.checks.length, ms: Math.round(g.ms) } });
        return;
      }

      case "deletion_approved":
      case "deleting": {
        const src = await this.source(job);
        if (this.d.hooks?.beforeDeletionGate) await this.d.hooks.beforeDeletionGate(src);
        const settings = await loadSettings(this.d.cp);
        const plan = await planGroup(src, job.spec);
        const v = (await this.d.cp.query(`SELECT verified, attempt, verified_at FROM control.archive_verifications WHERE job_id = $1 ORDER BY id DESC LIMIT 1`, [id])).rows[0];
        const { keys, intact } = await loadCandidates(this.d.cp, id, job.attempt);
        const gate = evaluateDeletionGate({
          config: this.d.config, environment: this.environment, killSwitch: settings.deletionKillSwitch, jobStatus: job.status, jobMode: job.mode,
          verification: v ? { verified: v.verified, attempt: v.attempt, verifiedAt: new Date(v.verified_at).toISOString() } : null,
          currentAttempt: job.attempt, jobSchemaHash: job.schema_hash, liveSchemaHash: plan.schemaHash, jobGraphHash: job.graph_hash, liveGraphHash: plan.graphHash,
          candidateSetIntact: intact,
        });
        if (!gate.allowed) {
          await audit(this.d.cp, { ...a, action: "deletion_blocked", result: "blocked", detail: { reasons: gate.reasons, deleted: 0 } });
          if (gate.reasons.some((r) => r.startsWith("schema hash") || r.startsWith("FK graph") || r.startsWith("frozen candidate"))) {
            await this.set(id, { status: "requires_review", failure: { reason: "drift_or_integrity", reasons: gate.reasons, deleted: 0 }, finished_at: new Date().toISOString() });
          } else if (gate.reasons.length === 1 && gate.reasons[0]!.startsWith("verification is")) {
            await this.set(id, { status: "verifying" });
            return;
          }
          return gate.reasons;
        }
        if (job.status === "deletion_approved") {
          await audit(this.d.cp, { ...a, action: "deletion_attempted", result: "info", detail: { rows: Object.values(keys).reduce((s, k) => s + k.length, 0) } });
          await this.set(id, { status: "deleting" });
        }
        this.crash("before_deletion");
        const batchSize = Math.min(settings.deletionBatchSize, this.d.config.maxDeletionBatchSize);
        const parentOf = Object.fromEntries(plan.spec.tables.map((t) => [t, plan.links[t]?.parent ?? null]));
        const batches = buildBatches(keys, plan.spec.root, plan.deleteOrder, parentOf, batchSize);
        const done = new Set((await this.d.cp.query(`SELECT batch_no FROM control.archive_deletion_batches WHERE job_id = $1 AND state = 'done'`, [id])).rows.map((r) => r.batch_no as number));
        const half = Math.floor(batches.length / 2);
        for (let i = 0; i < batches.length; i++) {
          if (done.has(i)) continue;
          const s2 = await loadSettings(this.d.cp);
          if (s2.deletionKillSwitch) {
            await audit(this.d.cp, { ...a, action: "deletion_blocked", result: "blocked", detail: { reason: "kill switch engaged during deletion", atBatch: i } });
            await this.set(id, { status: "requires_review", failure: { reason: "kill_switch", atBatch: i } });
            return ["deletion kill switch is ON"];
          }
          const live = await planGroup(src, job.spec);
          if (live.schemaHash !== job.schema_hash || live.graphHash !== job.graph_hash) {
            await audit(this.d.cp, { ...a, action: "deletion_blocked", result: "blocked", detail: { reason: "schema drift during deletion", atBatch: i } });
            await this.set(id, { status: "requires_review", failure: { reason: "schema_drift_during_deletion", atBatch: i } });
            return ["schema hash changed during deletion"];
          }
          const requested = Object.values(batches[i]!).reduce((s, r) => s + r.length, 0);
          await this.d.cp.query(
            `INSERT INTO control.archive_deletion_batches (job_id, batch_no, state, requested) VALUES ($1,$2,'started',$3)
             ON CONFLICT (job_id, batch_no) DO UPDATE SET attempts = control.archive_deletion_batches.attempts + 1, started_at = clock_timestamp()`,
            [id, i, requested]);
          const out = await deleteBatch(src, {
            deleteOrder: plan.deleteOrder, schemas: plan.schemas, edges: plan.edges, lockTimeoutMs: 2_000, statementTimeoutMs: 30_000,
            beforeCommit: async () => {
              if (i === half && this.d.faults?.at === "mid_deletion_in_txn") {
                (src as unknown as { connection: { stream: { destroy(): void } } }).connection.stream.destroy();
                throw new CrashSignal("mid_deletion_in_txn");
              }
            },
          }, batches[i]!);
          if (i === half) this.crash("mid_deletion_after_commit");
          const sum = (f: keyof TableOutcome) => Object.values(out).reduce((s, o) => s + o[f], 0);
          await this.d.cp.query(
            `UPDATE control.archive_deletion_batches SET state = 'done', deleted = $3, skipped = $4, missing = $5, per_table = $6, finished_at = clock_timestamp()
             WHERE job_id = $1 AND batch_no = $2`,
            [id, i, sum("deleted"), sum("drifted") + sum("held"), sum("missing"), JSON.stringify(out)]);
          await audit(this.d.cp, { ...a, action: "deletion_batch_completed", result: "success",
            detail: { batch: i, of: batches.length, deleted: sum("deleted"), skipped: sum("drifted") + sum("held"), missing: sum("missing") } });
          if (this.d.hooks?.afterDeletionBatch) await this.d.hooks.afterDeletionBatch(i);
        }
        this.crash("after_deletion");
        await this.set(id, { status: "verifying_deletion" });
        return;
      }

      case "verifying_deletion": {
        const src = await this.source(job);
        const plan = await planGroup(src, job.spec);
        const { keys } = await loadCandidates(this.d.cp, id, job.attempt);
        const batches = (await this.d.cp.query(`SELECT state, per_table, attempts FROM control.archive_deletion_batches WHERE job_id = $1`, [id])).rows;
        this.crash("during_deletion_verification");
        const report: Record<string, unknown> = {};
        let ok = batches.every((b) => b.state === "done");
        let exceptions = false;
        for (const t of plan.spec.tables) {
          const agg = { requested: 0, deleted: 0, skipped: 0, missing: 0, missingOnRetriedBatches: 0 };
          for (const b of batches) {
            const o = (b.per_table ?? {})[t] as TableOutcome | undefined;
            if (!o) continue;
            agg.requested += o.requested; agg.deleted += o.deleted; agg.skipped += o.drifted + o.held; agg.missing += o.missing;
            if (b.attempts > 1) agg.missingOnRetriedBatches += o.missing;
          }
          const s = plan.schemas[t]!;
          const pk = s.primaryKey[0]!;
          const pkType = s.columns.find((x) => x.name === pk)!.type;
          const stillPresent = Number((await src.query(`SELECT count(*) n FROM ${qi(t)} WHERE ${qi(pk)} = ANY($1::${pkType}[])`, [(keys[t] ?? []).map((k) => k.pk)])).rows[0].n);
          const frozen = (keys[t] ?? []).length;
          const reconciled = agg.requested === frozen && agg.deleted + agg.skipped + agg.missing === frozen && stillPresent === agg.skipped;
          ok &&= reconciled;
          if (agg.skipped > 0) exceptions = true;
          report[t] = { frozen, ...agg, stillPresent, reconciled };
          await this.d.cp.query(`UPDATE control.archive_job_tables SET deleted = $3, skipped = $4, missing = $5, reconciled = $6 WHERE job_id = $1 AND table_name = $2`,
            [id, t, agg.deleted, agg.skipped, agg.missing, reconciled]);
        }
        // Post-job maintenance: plain VACUUM (ANALYZE) only — never VACUUM FULL (Phase 3A P10).
        // A role without MAINTAIN/ownership gets a WARNING ("skipping"), not an error — capture notices.
        const maintenance: Record<string, string> = {};
        for (const t of plan.spec.tables) {
          const notices: string[] = [];
          const onNotice = (n: { message?: string }) => notices.push(String(n.message ?? ""));
          src.on("notice", onNotice);
          try {
            await src.query(`VACUUM (ANALYZE) ${qi(t)}`);
            const skip = notices.find((m) => /skipping/i.test(m));
            maintenance[t] = skip ? `skipped: ${skip}` : "vacuum_analyze_ok";
          } catch (e) { maintenance[t] = `skipped: ${(e as Error).message}`; }
          finally { src.off("notice", onNotice); }
        }
        const final: JobStatus = ok ? (exceptions ? "completed_with_exceptions" : "completed") : "requires_review";
        await audit(this.d.cp, { ...a, action: "deletion_verified", result: ok ? "success" : "failure", detail: { report, maintenance } });
        await audit(this.d.cp, { ...a, action: "deletion_completed", result: ok ? "success" : "failure", detail: { status: final } });
        await this.set(id, { status: final, finished_at: new Date().toISOString(), failure: ok ? null : { reason: "reconciliation_failed", report } });
        return;
      }

      default:
        throw new Error(`unhandled status ${job.status}`);
    }
  }
}
