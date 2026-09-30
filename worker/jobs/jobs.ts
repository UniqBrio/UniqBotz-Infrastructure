import type pg from "pg";
import { audit } from "../audit/audit";
import { listPolicies, loadApplication, loadSettings } from "../controlplane/repository";
import { NotReadyError, type BlockerCode } from "../readiness/blockers";
import { eligibilityCutoffDay, localToday, type GroupSpec } from "../retention/group";
import type { JobMode } from "./states";

export class DuplicateJobError extends Error {
  constructor(group: string) {
    super(`an active job already exists for ${group} (one active job per dependency group)`);
    this.name = "DuplicateJobError";
  }
}
/** Job creation refused because required configuration is missing (fail-safe; never defaulted). */
export class PolicyNotReadyError extends NotReadyError {
  constructor(codes: BlockerCode | BlockerCode[], detail?: string) {
    super(codes, detail);
    this.name = "PolicyNotReadyError";
    this.message = `cannot create job: ${this.message}`;
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
  if (!app.enabled || !app.capabilities.archive || !app.connections.archive) throw new PolicyNotReadyError("ARCHIVE_EXECUTION_UNAVAILABLE", "application has no archive capability/connection");
  const settings = await loadSettings(cp);
  const policies = await listPolicies(cp, input.applicationId);
  const root = policies.find((p) => `${p.schemaName}.${p.tableName}` === input.groupRoot);
  if (!root || root.policy !== "ARCHIVE" || !root.enabled) throw new PolicyNotReadyError("RETENTION_POLICY_NOT_CONFIGURED", `${input.groupRoot} is not an enabled ARCHIVE policy`);
  const members = policies.filter((p) => p.groupRoot === input.groupRoot && `${p.schemaName}.${p.tableName}` !== input.groupRoot);
  const bad = members.filter((m) => m.policy !== "ARCHIVE" || !m.enabled);
  if (bad.length) throw new PolicyNotReadyError("RETENTION_POLICY_NOT_CONFIGURED", `group members not enabled for ARCHIVE: ${bad.map((b) => b.tableName).join(", ")}`);
  const grace = root.gracePeriodDays ?? settings.defaultGracePeriodDays;
  const tz = root.timeZone ?? app.timeZone;
  const missing: BlockerCode[] = [];
  if (!root.dateColumn) missing.push("RETENTION_DATE_COLUMN_NOT_CONFIGURED");
  if (root.protectedPeriodMonths === null) missing.push("PROTECTED_PERIOD_NOT_CONFIGURED");
  if (root.targetRecords === null) missing.push("TARGET_NOT_CONFIGURED");
  if (grace === null) missing.push("GRACE_PERIOD_NOT_CONFIGURED");
  if (!tz) missing.push("APPLICATION_TIMEZONE_NOT_CONFIGURED");
  if (missing.length || grace === null || !tz) throw new PolicyNotReadyError(missing, input.groupRoot);
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

/*
 * Phase 3C: the single-step Phase 3B `approveDeletion` was removed. Deletion now requires the approval chain in
 * ../approvals/approvals.ts (evidence-bound APPROVER decisions + quorum + explicit ADMIN authorization), which the
 * worker re-validates at execution time.
 */

export async function cancelJob(cp: pg.Client, jobId: string, operator: string, reason: string) {
  const r = await cp.query(
    `UPDATE control.archive_jobs SET status = 'cancelled', failure = $2, updated_at = now(), finished_at = now()
     WHERE id = $1 AND status NOT IN ('deleting', 'verifying_deletion', 'completed', 'completed_with_exceptions', 'failed', 'cancelled', 'requires_review')
     RETURNING application_id`, [jobId, JSON.stringify({ reason, by: operator, deleted: 0 })]);
  if (r.rowCount !== 1) throw new Error(`job ${jobId} cannot be cancelled in its current state`);
  await audit(cp, { action: "operator_action", result: "success", applicationId: r.rows[0].application_id, jobId, actor: { type: "user", name: operator }, detail: { cancel: reason } });
}
