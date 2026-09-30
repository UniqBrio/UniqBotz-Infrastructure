import { createHash } from "node:crypto";
import type pg from "pg";
import { can } from "../../src/lib/auth/permissions";
import { audit } from "../audit/audit";
import { loadOperator } from "../controlplane/operators";
import { loadSettings, type SystemSettingsRow } from "../controlplane/repository";
import { beginOwned } from "../connection/transaction";
import { BLOCKERS } from "../readiness/blockers";

/**
 * Deletion approval workflow (Phase 3C §5, §12):
 *
 *   Archive Verified → Deletion Review → Approval(s) → Deletion Authorization → Worker Execution
 *
 * - Every decision is BOUND to the evidence the person reviewed (attempt, manifest checksum, schema hash,
 *   FK-graph hash, candidate-set digest). If anything changes (e.g. a re-export), earlier approvals no longer count.
 * - Approval-policy values (quorum, validity, creator exclusion, authorization validity, deletion window) are
 *   business decisions. While any is NULL: DELETION NOT AUTHORIZED.
 * - This module records decisions only. It never deletes. The worker re-validates everything at execution
 *   time and remains the final authority (ALLOW_DELETION, environment, kill switch, …).
 */

export interface EvidenceKey {
  attempt: number;
  manifestSha256: string | null;
  schemaHash: string | null;
  graphHash: string | null;
  candidateDigest: string | null;
}

export interface TableImpact {
  table: string;
  rowsToDelete: number;
  tableRows: number | null;
  pctOfTable: number | null;
  tableBytes: number | null;
  /** Rough share of heap space that becomes reusable (NOT returned to the OS; VACUUM FULL is never run). */
  estReusableBytes: number | null;
}

export interface DeletionEvidence extends EvidenceKey {
  jobId: string;
  applicationId: string;
  applicationName: string;
  environment: string;
  mode: string;
  status: string;
  createdBy: string;
  tables: string[];
  rowsByTable: Record<string, number>;
  candidateRows: number;
  candidateSetIntact: boolean;
  oldestDay: string | null;
  boundaryDay: string | null;
  storeUri: string | null;
  archiveDataBytes: number;
  verification: {
    id: number;
    verified: boolean;
    verifiedAt: string;
    failedStage: string | null;
    keySetPassed: boolean;
    restoreFingerprintPassed: boolean;
    schemaHashPassed: boolean;
  } | null;
  impact: TableImpact[];
}

export interface ApprovalRecord {
  id: number;
  operatorId: string;
  email: string | null;
  role: string;
  decision: "approve" | "reject";
  comment: string | null;
  decidedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  evidence: EvidenceKey;
  counts: boolean;
  notCountingReason: string | null;
}

export interface AuthorizationRecord {
  id: number;
  operatorId: string;
  authorizedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  consumedAt: string | null;
  evidence: EvidenceKey;
}

export class ApprovalRefusedError extends Error {
  constructor(public reasons: string[]) {
    super(`${BLOCKERS.DELETION_NOT_AUTHORIZED}: ${reasons.join("; ")}`);
    this.name = "ApprovalRefusedError";
  }
}
export class DuplicateApprovalError extends Error {
  constructor(jobId: string, operatorId: string) {
    super(`operator ${operatorId} has already decided on job ${jobId} for this attempt (duplicate approval refused)`);
    this.name = "DuplicateApprovalError";
  }
}

type Q = pg.Client | pg.PoolClient;

export async function candidateDigest(cp: Q, jobId: string, attempt: number): Promise<string | null> {
  const r = (await cp.query(
    `SELECT string_agg(table_name || ':' || chunk_no || ':' || chunk_sha256, ',' ORDER BY table_name, chunk_no) AS d
     FROM control.archive_job_candidates WHERE job_id = $1 AND attempt = $2`, [jobId, attempt])).rows[0];
  return r?.d ? createHash("sha256").update(r.d).digest("hex") : null;
}

export function sameEvidence(a: EvidenceKey, b: EvidenceKey): boolean {
  return a.attempt === b.attempt && !!a.manifestSha256 && a.manifestSha256 === b.manifestSha256 && !!a.schemaHash && a.schemaHash === b.schemaHash
    && !!a.graphHash && a.graphHash === b.graphHash && !!a.candidateDigest && a.candidateDigest === b.candidateDigest;
}

export function evidenceKey(e: DeletionEvidence): EvidenceKey {
  return { attempt: e.attempt, manifestSha256: e.manifestSha256, schemaHash: e.schemaHash, graphHash: e.graphHash, candidateDigest: e.candidateDigest };
}

export async function loadDeletionEvidence(cp: Q, jobId: string): Promise<DeletionEvidence | null> {
  const j = (await cp.query(
    `SELECT j.*, a.name AS app_name, a.environment FROM control.archive_jobs j JOIN control.applications a ON a.id = j.application_id WHERE j.id = $1`, [jobId])).rows[0];
  if (!j) return null;
  const m = (await cp.query(`SELECT manifest_sha256, store_uri, files FROM control.archive_manifests WHERE job_id = $1 AND attempt = $2`, [jobId, j.attempt])).rows[0];
  const v = (await cp.query(
    `SELECT id, verified, verified_at, failed_stage, checks FROM control.archive_verifications WHERE job_id = $1 AND attempt = $2 ORDER BY id DESC LIMIT 1`, [jobId, j.attempt])).rows[0];
  const counts = (await cp.query(
    `SELECT table_name, sum(row_count)::bigint AS n, bool_and(cardinality(pks) = row_count) AS ok FROM control.archive_job_candidates WHERE job_id = $1 AND attempt = $2 GROUP BY 1`,
    [jobId, j.attempt])).rows;
  const rowsByTable = Object.fromEntries(counts.map((r) => [r.table_name as string, Number(r.n)]));
  const stagePassed = (stage: string) => Boolean(v?.checks?.length) && (v.checks as { stage: string; pass: boolean }[]).filter((c) => c.stage === stage).length > 0
    && (v.checks as { stage: string; pass: boolean }[]).filter((c) => c.stage === stage).every((c) => c.pass);
  const tables: string[] = j.tables;
  const impact: TableImpact[] = [];
  for (const t of tables) {
    const [schema, name] = t.split(".");
    const d = (await cp.query(
      `SELECT coalesce(exact_rows, estimated_rows) AS n, table_bytes FROM control.discovered_tables WHERE application_id = $1 AND schema_name = $2 AND table_name = $3`,
      [j.application_id, schema, name])).rows[0];
    const rows = rowsByTable[t] ?? 0;
    const tableRows = d?.n === null || d?.n === undefined ? null : Number(d.n);
    const pct = tableRows ? Math.round((rows / tableRows) * 10_000) / 100 : null;
    const bytes = d?.table_bytes === null || d?.table_bytes === undefined ? null : Number(d.table_bytes);
    impact.push({ table: t, rowsToDelete: rows, tableRows, pctOfTable: pct, tableBytes: bytes, estReusableBytes: bytes !== null && tableRows ? Math.round((bytes * rows) / tableRows) : null });
  }
  const files = (m?.files ?? {}) as Record<string, { bytes: number }>;
  return {
    jobId: j.id,
    applicationId: j.application_id,
    applicationName: j.app_name,
    environment: j.environment,
    mode: j.mode,
    status: j.status,
    createdBy: j.created_by,
    tables,
    rowsByTable,
    candidateRows: Object.values(rowsByTable).reduce((s, n) => s + n, 0),
    candidateSetIntact: counts.length > 0 && counts.every((r) => r.ok),
    oldestDay: j.selection?.oldestDate ?? null,
    boundaryDay: j.selection?.boundaryDate ?? null,
    storeUri: m?.store_uri ?? null,
    archiveDataBytes: Object.entries(files).filter(([k]) => k.includes("/data/")).reduce((s, [, f]) => s + f.bytes, 0),
    attempt: j.attempt,
    manifestSha256: m?.manifest_sha256 ?? null,
    schemaHash: j.schema_hash,
    graphHash: j.graph_hash,
    candidateDigest: await candidateDigest(cp, jobId, j.attempt),
    verification: v ? {
      id: Number(v.id), verified: v.verified, verifiedAt: new Date(v.verified_at).toISOString(), failedStage: v.failed_stage,
      keySetPassed: stagePassed("archive_key_set"), restoreFingerprintPassed: stagePassed("restore_fingerprint"), schemaHashPassed: stagePassed("schema_hash"),
    } : null,
    impact,
  };
}

/** Approval-policy values; each NULL is an undecided business rule → DELETION NOT AUTHORIZED. */
export function approvalPolicyGaps(s: SystemSettingsRow): string[] {
  const p = s.approvalPolicy;
  const gaps: string[] = [];
  if (p.requiredApprovers === null) gaps.push("required number of approvers");
  if (p.approvalValidityMinutes === null) gaps.push("approval validity (expiry)");
  if (p.excludesJobCreator === null) gaps.push("whether the job creator may approve");
  if (p.authorizationValidityMinutes === null) gaps.push("authorization validity (expiry)");
  if (p.deletionWindow === null) gaps.push("deletion time window");
  return gaps;
}

/** Local wall-clock window check; supports windows that wrap midnight (e.g. 22:00–05:00). */
export function withinDeletionWindow(now: Date, w: { start: string; end: string; timeZone: string }): boolean {
  const hm = new Intl.DateTimeFormat("en-GB", { timeZone: w.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
  const cur = hm.slice(0, 5);
  const start = w.start.slice(0, 5);
  const end = w.end.slice(0, 5);
  return start <= end ? cur >= start && cur < end : cur >= start || cur < end;
}

function refuse(reasons: string[]): never {
  throw new ApprovalRefusedError(reasons);
}

async function listApprovalRows(cp: Q, jobId: string, attempt: number) {
  return (await cp.query(
    `SELECT a.*, o.email FROM control.deletion_approvals a JOIN control.operators o ON o.id = a.operator_id
     WHERE a.job_id = $1 AND a.attempt = $2 ORDER BY a.id`, [jobId, attempt])).rows;
}

/** Evaluate which approvals count toward the quorum right now. */
export async function evaluateApprovals(cp: Q, ev: DeletionEvidence, settings: SystemSettingsRow, now: Date): Promise<{ records: ApprovalRecord[]; valid: ApprovalRecord[]; rejected: boolean }> {
  const rows = await listApprovalRows(cp, ev.jobId, ev.attempt);
  const current = evidenceKey(ev);
  const records: ApprovalRecord[] = [];
  for (const r of rows) {
    const op = await loadOperator(cp, r.operator_id);
    let why: string | null = null;
    if (r.decision !== "approve") why = "rejection";
    else if (r.revoked_at) why = "revoked";
    else if (!r.expires_at || new Date(r.expires_at) <= now) why = "expired";
    else if (!sameEvidence(r.evidence, current)) why = "evidence changed since this approval";
    else if (!op || !op.active || !can(op.roles, "approve_deletion")) why = "approver no longer holds the APPROVER role";
    else if (settings.approvalPolicy.excludesJobCreator && r.operator_id === ev.createdBy) why = "job creator may not approve";
    records.push({
      id: Number(r.id), operatorId: r.operator_id, email: r.email, role: r.role_at_decision, decision: r.decision, comment: r.comment,
      decidedAt: new Date(r.decided_at).toISOString(), expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
      revokedAt: r.revoked_at ? new Date(r.revoked_at).toISOString() : null, evidence: r.evidence, counts: why === null, notCountingReason: why,
    });
  }
  return { records, valid: records.filter((x) => x.counts), rejected: records.some((x) => x.decision === "reject" && !x.revokedAt && sameEvidence(x.evidence, current)) };
}

function commonRefusals(ev: DeletionEvidence | null, ack: EvidenceKey | null | undefined): string[] {
  if (!ev) return ["unknown job"];
  const reasons: string[] = [];
  if (ev.mode !== "ARCHIVE_VERIFY_DELETE") reasons.push(`job mode is ${ev.mode} — this job can never be approved for deletion`);
  if (ev.status !== "ready_for_deletion") reasons.push(`job status is ${ev.status} (requires ready_for_deletion)`);
  if (!ev.verification?.verified) reasons.push("archive verification has not passed for the current attempt");
  if (!ev.candidateSetIntact) reasons.push("frozen candidate set failed its integrity check");
  if (!ack || !sameEvidence(ack, evidenceKey(ev))) reasons.push("the evidence you reviewed is not the current evidence — reload the deletion review");
  return reasons;
}

export interface DecisionInput {
  jobId: string;
  operatorId: string;
  decision: "approve" | "reject";
  comment?: string | null;
  evidenceAck: EvidenceKey | null | undefined;
  now?: Date;
}

/** Record one APPROVER decision. Serialised per job (row lock); one decision per person per attempt. */
export async function recordApprovalDecision(cp: pg.Client, input: DecisionInput): Promise<ApprovalRecord> {
  const now = input.now ?? new Date();
  const reasons: string[] = [];
  let appId: string | null = null;
  await beginOwned(cp);
  try {
    await cp.query(`SELECT id FROM control.archive_jobs WHERE id = $1 FOR UPDATE`, [input.jobId]);
    const ev = await loadDeletionEvidence(cp, input.jobId);
    appId = ev?.applicationId ?? null;
    const settings = await loadSettings(cp as pg.Client);
    const op = await loadOperator(cp, input.operatorId);
    if (!op || !op.active) reasons.push("operator is not an active, registered operator");
    else if (!can(op.roles, "approve_deletion")) reasons.push("operator does not hold the APPROVER role");
    const gaps = approvalPolicyGaps(settings);
    if (gaps.length) reasons.push(`${BLOCKERS.APPROVAL_POLICY_NOT_CONFIGURED} (${gaps.join(", ")})`);
    reasons.push(...commonRefusals(ev, input.evidenceAck));
    if (ev && settings.approvalPolicy.excludesJobCreator && ev.createdBy === input.operatorId) reasons.push("the job creator may not approve this job");
    if (!["approve", "reject"].includes(input.decision)) reasons.push("decision must be approve or reject");
    if (reasons.length) refuse(reasons);
    const expires = input.decision === "approve" ? new Date(now.getTime() + settings.approvalPolicy.approvalValidityMinutes! * 60_000) : null;
    const r = await cp.query(
      `INSERT INTO control.deletion_approvals (job_id, attempt, operator_id, role_at_decision, decision, comment, evidence, decided_at, expires_at)
       VALUES ($1,$2,$3,'APPROVER',$4,$5,$6,$7,$8) RETURNING id`,
      [input.jobId, ev!.attempt, input.operatorId, input.decision, input.comment ?? null, JSON.stringify(evidenceKey(ev!)), now.toISOString(), expires?.toISOString() ?? null]);
    await cp.query("COMMIT");
    await audit(cp, { action: input.decision === "approve" ? "approval_recorded" : "approval_rejected", result: "success", applicationId: appId, jobId: input.jobId,
      actor: { type: "user", name: input.operatorId }, detail: { attempt: ev!.attempt, evidence: evidenceKey(ev!), expiresAt: expires?.toISOString() ?? null, comment: input.comment ?? null } });
    return (await evaluateApprovals(cp, ev!, settings, now)).records.find((x) => x.id === Number(r.rows[0].id))!;
  } catch (e) {
    await cp.query("ROLLBACK").catch(() => {});
    if ((e as { code?: string }).code === "23505") {
      await audit(cp, { action: "access_denied", result: "blocked", applicationId: appId, jobId: input.jobId, actor: { type: "user", name: input.operatorId }, detail: { reason: "duplicate approval" } });
      throw new DuplicateApprovalError(input.jobId, input.operatorId);
    }
    if (e instanceof ApprovalRefusedError) {
      await audit(cp, { action: "deletion_blocked", result: "blocked", applicationId: appId, jobId: input.jobId, actor: { type: "user", name: input.operatorId }, detail: { step: "approval", reasons: e.reasons, deleted: 0 } });
    }
    throw e;
  }
}

export interface AuthorizeInput {
  jobId: string;
  operatorId: string;
  evidenceAck: EvidenceKey | null | undefined;
  /** Typed confirmation: must equal jobId. */
  confirmJobId: string;
  now?: Date;
}

/**
 * Issue the explicit, expiring deletion authorization (ADMIN), after the approval quorum.
 * Moves the job to deletion_approved. It DELETES NOTHING: the worker validates everything again and, while
 * ALLOW_DELETION=false or the kill switch is engaged, refuses.
 */
export async function authorizeDeletion(cp: pg.Client, input: AuthorizeInput): Promise<AuthorizationRecord> {
  const now = input.now ?? new Date();
  let appId: string | null = null;
  await beginOwned(cp);
  try {
    await cp.query(`SELECT id FROM control.archive_jobs WHERE id = $1 FOR UPDATE`, [input.jobId]);
    const ev = await loadDeletionEvidence(cp, input.jobId);
    appId = ev?.applicationId ?? null;
    const settings = await loadSettings(cp as pg.Client);
    const reasons: string[] = [];
    const op = await loadOperator(cp, input.operatorId);
    if (!op || !op.active) reasons.push("operator is not an active, registered operator");
    else if (!can(op.roles, "authorize_deletion")) reasons.push("operator does not hold the ADMIN role");
    const gaps = approvalPolicyGaps(settings);
    if (gaps.length) reasons.push(`${BLOCKERS.APPROVAL_POLICY_NOT_CONFIGURED} (${gaps.join(", ")})`);
    reasons.push(...commonRefusals(ev, input.evidenceAck));
    if (input.confirmJobId !== input.jobId) reasons.push("typed confirmation does not match the job ID");
    if (ev && !gaps.length) {
      const { valid, rejected } = await evaluateApprovals(cp, ev, settings, now);
      if (rejected) reasons.push("an approver rejected this deletion");
      if (valid.length < settings.approvalPolicy.requiredApprovers!) reasons.push(`approval quorum not met (${valid.length} of ${settings.approvalPolicy.requiredApprovers} valid approvals)`);
      if (valid.some((a) => a.operatorId === input.operatorId)) reasons.push("the authorizer may not also be an approver of the same job (separation of duties)");
    }
    if (reasons.length) refuse(reasons);
    const { valid } = await evaluateApprovals(cp, ev!, settings, now);
    const expires = new Date(now.getTime() + settings.approvalPolicy.authorizationValidityMinutes! * 60_000);
    const r = await cp.query(
      `INSERT INTO control.deletion_authorizations (job_id, attempt, operator_id, role_at_decision, approval_ids, evidence, authorized_at, expires_at)
       VALUES ($1,$2,$3,'ADMIN',$4,$5,$6,$7) RETURNING id`,
      [input.jobId, ev!.attempt, input.operatorId, valid.map((a) => a.id), JSON.stringify(evidenceKey(ev!)), now.toISOString(), expires.toISOString()]);
    await cp.query(`UPDATE control.archive_jobs SET status = 'deletion_approved', approved_by = $2, approved_at = $3, updated_at = now() WHERE id = $1`,
      [input.jobId, input.operatorId, now.toISOString()]);
    await cp.query("COMMIT");
    await audit(cp, { action: "deletion_authorized", result: "success", applicationId: appId, jobId: input.jobId, actor: { type: "user", name: input.operatorId },
      detail: { attempt: ev!.attempt, approvals: valid.map((a) => a.operatorId), expiresAt: expires.toISOString(), evidence: evidenceKey(ev!), note: "authorization only — the worker re-validates every gate" } });
    return { id: Number(r.rows[0].id), operatorId: input.operatorId, authorizedAt: now.toISOString(), expiresAt: expires.toISOString(), revokedAt: null, consumedAt: null, evidence: evidenceKey(ev!) };
  } catch (e) {
    await cp.query("ROLLBACK").catch(() => {});
    if ((e as { code?: string }).code === "23505") {
      await audit(cp, { action: "access_denied", result: "blocked", applicationId: appId, jobId: input.jobId, actor: { type: "user", name: input.operatorId }, detail: { reason: "duplicate authorization" } });
      throw new ApprovalRefusedError(["a live authorization already exists for this job attempt"]);
    }
    if (e instanceof ApprovalRefusedError) {
      await audit(cp, { action: "deletion_blocked", result: "blocked", applicationId: appId, jobId: input.jobId, actor: { type: "user", name: input.operatorId }, detail: { step: "authorization", reasons: e.reasons, deleted: 0 } });
    }
    throw e;
  }
}

export async function revokeAuthorization(cp: pg.Client, jobId: string, by: string, reason: string) {
  const r = await cp.query(`UPDATE control.deletion_authorizations SET revoked_at = now(), revoked_by = $2 WHERE job_id = $1 AND revoked_at IS NULL RETURNING id`, [jobId, by]);
  await cp.query(`UPDATE control.deletion_approvals SET revoked_at = now(), revoked_by = $2 WHERE job_id = $1 AND revoked_at IS NULL`, [jobId, by]);
  await cp.query(`UPDATE control.archive_jobs SET status = 'ready_for_deletion', updated_at = now() WHERE id = $1 AND status = 'deletion_approved'`, [jobId]);
  await audit(cp, { action: "authorization_revoked", result: "success", jobId, actor: { type: "user", name: by }, detail: { reason, authorizations: r.rowCount } });
}

export async function listAuthorizations(cp: Q, jobId: string): Promise<AuthorizationRecord[]> {
  return (await cp.query(`SELECT * FROM control.deletion_authorizations WHERE job_id = $1 ORDER BY id`, [jobId])).rows.map((r) => ({
    id: Number(r.id), operatorId: r.operator_id, authorizedAt: new Date(r.authorized_at).toISOString(), expiresAt: new Date(r.expires_at).toISOString(),
    revokedAt: r.revoked_at ? new Date(r.revoked_at).toISOString() : null, consumedAt: r.consumed_at ? new Date(r.consumed_at).toISOString() : null, evidence: r.evidence,
  }));
}

/**
 * Worker-side validation of the human authorization chain. Called by the runner before execution starts
 * (atStart) and before every batch (revocation / role removal stops a running deletion at the next batch).
 */
export async function validateExecutionAuthorization(cp: Q, jobId: string, now: Date, opts: { atStart: boolean }): Promise<string[]> {
  const ev = await loadDeletionEvidence(cp, jobId);
  if (!ev) return ["unknown job"];
  const settings = await loadSettings(cp as pg.Client);
  const reasons: string[] = [];
  const gaps = approvalPolicyGaps(settings);
  if (gaps.length) return [`${BLOCKERS.APPROVAL_POLICY_NOT_CONFIGURED} (${gaps.join(", ")})`];
  const auth = (await cp.query(`SELECT * FROM control.deletion_authorizations WHERE job_id = $1 AND attempt = $2 AND revoked_at IS NULL ORDER BY id DESC LIMIT 1`, [jobId, ev.attempt])).rows[0];
  if (!auth) return [`${BLOCKERS.DELETION_NOT_AUTHORIZED}: no live authorization for attempt ${ev.attempt}`];
  if (!sameEvidence(auth.evidence, evidenceKey(ev))) reasons.push("authorization evidence differs from the current job evidence");
  const admin = await loadOperator(cp, auth.operator_id);
  if (!admin || !can(admin.roles, "authorize_deletion")) reasons.push("the authorizing ADMIN no longer holds the role");
  if (opts.atStart) {
    if (new Date(auth.expires_at) <= now) reasons.push("authorization has expired");
    const { valid, rejected } = await evaluateApprovals(cp, ev, { ...settings }, now);
    if (rejected) reasons.push("an approver rejected this deletion");
    if (valid.length < settings.approvalPolicy.requiredApprovers!) reasons.push(`approval quorum no longer met (${valid.length} of ${settings.approvalPolicy.requiredApprovers})`);
    if (!withinDeletionWindow(now, settings.approvalPolicy.deletionWindow!)) {
      const w = settings.approvalPolicy.deletionWindow!;
      reasons.push(`outside the deletion window (${w.start.slice(0, 5)}–${w.end.slice(0, 5)} ${w.timeZone})`);
    }
  }
  return reasons.map((r) => (r.startsWith(BLOCKERS.DELETION_NOT_AUTHORIZED) || r.startsWith("DELETION NOT AUTHORIZED") ? r : `${BLOCKERS.DELETION_NOT_AUTHORIZED}: ${r}`));
}

export async function markAuthorizationConsumed(cp: Q, jobId: string, attempt: number) {
  await cp.query(`UPDATE control.deletion_authorizations SET consumed_at = coalesce(consumed_at, now()) WHERE job_id = $1 AND attempt = $2 AND revoked_at IS NULL`, [jobId, attempt]);
}
