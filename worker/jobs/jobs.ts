import type pg from "pg";
import { audit } from "../audit/audit";
import { listPolicies, loadApplication, loadSettings } from "../controlplane/repository";
import { eligibilityCutoffDay, localToday, type GroupSpec } from "../retention/group";
import type { JobMode } from "./states";

export class DuplicateJobError extends Error {
  constructor(group: string) {
    super(`an active job already exists for ${group} (one active job per dependency group)`);
    this.name = "DuplicateJobError";
  }
}
export class PolicyNotReadyError extends Error {
  constructor(why: string) {
    super(`cannot create job: ${why}`);
    this.name = "PolicyNotReadyError";
  }
}

export interface CreateJobInput {
  id: string;
  applicationId: string;
  groupRoot: string; // schema-qualified root table
  createdBy: string;
  mode?: JobMode;
  now?: Date;
}

/** Build the job spec from the stored, enabled ARCHIVE policies of a group. Never from ad-hoc input. */
export async function createJob(cp: pg.Client, input: CreateJobInput): Promise<GroupSpec> {
  const app = await loadApplication(cp, input.applicationId);
  if (!app.enabled || !app.capabilities.archive || !app.connections.archive) throw new PolicyNotReadyError("application has no archive capability/connection");
  const settings = await loadSettings(cp);
  const policies = await listPolicies(cp, input.applicationId);
  const root = policies.find((p) => `${p.schemaName}.${p.tableName}` === input.groupRoot);
  if (!root || root.policy !== "ARCHIVE" || !root.enabled) throw new PolicyNotReadyError(`${input.groupRoot} is not an enabled ARCHIVE policy`);
  const members = policies.filter((p) => p.groupRoot === input.groupRoot && `${p.schemaName}.${p.tableName}` !== input.groupRoot);
  const bad = members.filter((m) => m.policy !== "ARCHIVE" || !m.enabled);
  if (bad.length) throw new PolicyNotReadyError(`group members not enabled for ARCHIVE: ${bad.map((b) => b.tableName).join(", ")}`);
  const grace = root.gracePeriodDays ?? settings.defaultGracePeriodDays;
  if (grace === null) throw new PolicyNotReadyError("grace period is not configured (no built-in default)");
  const tz = root.timeZone ?? app.timeZone;
  const spec: GroupSpec = {
    applicationId: app.id,
    root: input.groupRoot,
    dateColumn: root.dateColumn!,
    tables: [input.groupRoot, ...members.map((m) => `${m.schemaName}.${m.tableName}`)],
    timeZone: tz,
    cutoffDay: eligibilityCutoffDay(localToday(tz, input.now), root.protectedPeriodMonths!, grace),
    target: root.targetRecords!,
  };
  try {
    await cp.query(
      `INSERT INTO control.archive_jobs (id, application_id, group_root, tables, mode, status, spec, created_by)
       VALUES ($1,$2,$3,$4,$5,'queued',$6,$7)`,
      [input.id, app.id, input.groupRoot, spec.tables, input.mode ?? "ARCHIVE_AND_VERIFY_ONLY", JSON.stringify(spec), input.createdBy]);
  } catch (e) {
    if ((e as { code?: string }).code === "23505") {
      await audit(cp, { action: "job_duplicate_rejected", result: "blocked", applicationId: app.id, tableName: input.groupRoot, actor: { type: "user", name: input.createdBy } });
      throw new DuplicateJobError(input.groupRoot);
    }
    throw e;
  }
  await audit(cp, { action: "job_created", result: "success", applicationId: app.id, jobId: input.id, tableName: input.groupRoot,
    actor: { type: "user", name: input.createdBy }, detail: { mode: input.mode ?? "ARCHIVE_AND_VERIFY_ONLY", spec } });
  return spec;
}

/** Operator approval. Refused for ARCHIVE_AND_VERIFY_ONLY jobs and anything not ready_for_deletion. */
export async function approveDeletion(cp: pg.Client, jobId: string, operator: string): Promise<void> {
  const job = (await cp.query(`SELECT status, mode, application_id FROM control.archive_jobs WHERE id = $1`, [jobId])).rows[0];
  if (!job) throw new Error(`unknown job ${jobId}`);
  if (job.mode !== "ARCHIVE_VERIFY_DELETE" || job.status !== "ready_for_deletion") {
    await audit(cp, { action: "deletion_blocked", result: "blocked", applicationId: job.application_id, jobId, actor: { type: "user", name: operator },
      detail: { reason: job.mode !== "ARCHIVE_VERIFY_DELETE" ? "job mode ARCHIVE_AND_VERIFY_ONLY cannot be approved for deletion" : `status ${job.status}` } });
    throw new Error(`job ${jobId} cannot be approved for deletion (mode ${job.mode}, status ${job.status})`);
  }
  await cp.query(`UPDATE control.archive_jobs SET status = 'deletion_approved', approved_by = $2, approved_at = now(), updated_at = now() WHERE id = $1`, [jobId, operator]);
  await audit(cp, { action: "deletion_approved", result: "success", applicationId: job.application_id, jobId, actor: { type: "user", name: operator } });
}

export async function cancelJob(cp: pg.Client, jobId: string, operator: string, reason: string) {
  const r = await cp.query(
    `UPDATE control.archive_jobs SET status = 'cancelled', failure = $2, updated_at = now(), finished_at = now()
     WHERE id = $1 AND status NOT IN ('deleting', 'verifying_deletion', 'completed', 'completed_with_exceptions', 'failed', 'cancelled', 'requires_review')
     RETURNING application_id`, [jobId, JSON.stringify({ reason, by: operator, deleted: 0 })]);
  if (r.rowCount !== 1) throw new Error(`job ${jobId} cannot be cancelled in its current state`);
  await audit(cp, { action: "operator_action", result: "success", applicationId: r.rows[0].application_id, jobId, actor: { type: "user", name: operator }, detail: { cancel: reason } });
}
