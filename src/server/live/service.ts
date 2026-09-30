import "server-only";
import pg from "pg";
import { deriveApplicationHealth } from "@/lib/domain/health";
import type { ApplicationHealth, ArchiveJob, TableHealth } from "@/lib/domain/types";
import { isRole } from "@/lib/auth/permissions";
import { approvalPolicyGaps, evaluateApprovals, listAuthorizations, loadDeletionEvidence } from "../../../worker/approvals/approvals";
import { loadSettings } from "../../../worker/controlplane/repository";
import { mapDeletionReview } from "./review";
import {
  mapAlert, mapApplication, mapAudit, mapCandidate, mapJob, mapPolicy, mapSettings, mapTable,
  type AlertRow, type AppRow, type AuditRow, type PolicyRow, type PreviewRow, type SettingsRow, type TableRow,
} from "./mapping";

/**
 * Server-side, READ-ONLY access to the control plane for the dashboard.
 * - Reads CONTROL_PLANE_DATABASE_URL from the server environment (never NEXT_PUBLIC_*).
 * - Every session is default_transaction_read_only: the web server cannot write the control plane.
 * - The web server never connects to application databases and never sees their credentials;
 *   only the worker resolves application secret references.
 */
let pool: pg.Pool | null = null;

export class LiveNotConfiguredError extends Error {
  constructor() {
    super("CONTROL_PLANE_DATABASE_URL is not configured on the server");
    this.name = "LiveNotConfiguredError";
  }
}

function db(): pg.Pool {
  if (pool) return pool;
  const url = process.env.CONTROL_PLANE_DATABASE_URL;
  if (!url) throw new LiveNotConfiguredError();
  pool = new pg.Pool({
    connectionString: url,
    max: 4,
    application_name: "uniqbotz-dashboard-readonly",
    options: "-c default_transaction_read_only=on -c search_path=control,public",
  });
  pool.on("error", () => {});
  return pool;
}

async function q<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db().query(sql, params)).rows as T[];
}

async function settingsRow() {
  return (await q<SettingsRow>(`SELECT * FROM control.system_settings WHERE id = 1`))[0]!;
}

export async function getSettings() {
  return mapSettings(await settingsRow());
}

export async function listApplications() {
  return (await q<AppRow>(`SELECT * FROM control.applications WHERE enabled ORDER BY name`)).map(mapApplication);
}

export async function listTables(applicationId?: string): Promise<TableHealth[]> {
  const settings = mapSettings(await settingsRow());
  const tables = await q<TableRow>(
    `SELECT * FROM control.discovered_tables WHERE is_present AND ($1::text IS NULL OR application_id = $1)`, [applicationId ?? null]);
  const policies = await q<PolicyRow>(`SELECT * FROM control.retention_policies WHERE ($1::text IS NULL OR application_id = $1)`, [applicationId ?? null]);
  return tables
    .map((t) => mapTable(t, policies.find((p) => p.application_id === t.application_id && p.schema_name === t.schema_name && p.table_name === t.table_name), settings))
    .sort((a, b) => b.rowCount - a.rowCount);
}

export async function listApplicationHealth(): Promise<ApplicationHealth[]> {
  const [apps, tables, settings] = await Promise.all([listApplications(), listTables(), getSettings()]);
  return apps.map((a) => deriveApplicationHealth(a, tables.filter((t) => t.applicationId === a.id), settings));
}

export async function getApplicationHealth(id: string) {
  return (await listApplicationHealth()).find((h) => h.application.id === id) ?? null;
}

export async function listRetentionPolicies(applicationId?: string) {
  return (await q<PolicyRow>(
    `SELECT p.* FROM control.retention_policies p JOIN control.discovered_tables t USING (application_id, schema_name, table_name)
     WHERE t.is_present AND ($1::text IS NULL OR p.application_id = $1)`, [applicationId ?? null])).map(mapPolicy);
}

export async function listArchiveCandidates(applicationId?: string) {
  const rows = await q<PreviewRow>(
    `SELECT cp.*, rp.protected_period_months,
            (SELECT j.id FROM control.archive_jobs j WHERE j.application_id = cp.application_id AND j.group_root = cp.group_root
               AND j.status NOT IN ('completed','completed_with_exceptions','failed','cancelled','requires_review') LIMIT 1) AS active_job_id,
            (SELECT j.selection->>'boundaryDate' FROM control.archive_jobs j WHERE j.application_id = cp.application_id AND j.group_root = cp.group_root
               AND j.status IN ('completed','completed_with_exceptions') ORDER BY j.finished_at DESC LIMIT 1) AS previous_boundary
     FROM control.candidate_previews cp
     LEFT JOIN control.retention_policies rp ON rp.application_id = cp.application_id AND rp.schema_name || '.' || rp.table_name = cp.group_root
     WHERE ($1::text IS NULL OR cp.application_id = $1) ORDER BY cp.computed_at DESC`, [applicationId ?? null]);
  return rows.map(mapCandidate);
}

async function jobBundle(jobId: string, batchSize: number): Promise<ArchiveJob | null> {
  const job = (await q<Record<string, unknown>>(`SELECT * FROM control.archive_jobs WHERE id = $1`, [jobId]))[0];
  if (!job) return null;
  const manifest = (await q<Record<string, unknown>>(`SELECT store_uri, files FROM control.archive_manifests WHERE job_id = $1 AND attempt = $2`, [jobId, job.attempt]))[0] ?? null;
  const verification = (await q<Record<string, unknown>>(`SELECT verified, failed_stage, checks, verified_at FROM control.archive_verifications WHERE job_id = $1 ORDER BY id DESC LIMIT 1`, [jobId]))[0] ?? null;
  const batches = await q<{ state: string; deleted: number | null }>(`SELECT state, deleted FROM control.archive_deletion_batches WHERE job_id = $1`, [jobId]);
  const counts = (await q<{ total: string | null; root: string | null }>(
    `SELECT sum(row_count) AS total, sum(row_count) FILTER (WHERE table_name = $2) AS root FROM control.archive_job_candidates WHERE job_id = $1 AND attempt = $3`,
    [jobId, job.group_root, job.attempt]))[0]!;
  return mapJob({
    job: job as never, manifest: manifest as never, verification: verification as never, batches,
    candidateRows: Number(counts.total ?? 0), rootRows: Number(counts.root ?? 0), batchSize,
  });
}

export async function listArchiveJobs(applicationId?: string) {
  const s = await settingsRow();
  const ids = await q<{ id: string }>(`SELECT id FROM control.archive_jobs WHERE ($1::text IS NULL OR application_id = $1) ORDER BY created_at DESC LIMIT 200`, [applicationId ?? null]);
  return (await Promise.all(ids.map((r) => jobBundle(r.id, s.deletion_batch_size)))).filter((j): j is ArchiveJob => j !== null);
}

export async function getArchiveJob(id: string) {
  return jobBundle(id, (await settingsRow()).deletion_batch_size);
}

export async function listAlerts(applicationId?: string) {
  const s = await settingsRow();
  return (await q<AlertRow>(`SELECT * FROM control.alerts WHERE ($1::text IS NULL OR application_id = $1) ORDER BY detected_at DESC LIMIT 500`, [applicationId ?? null]))
    .map((r) => mapAlert(r, s.whatsapp_destination));
}

export async function listAuditLog(applicationId?: string) {
  return (await q<AuditRow>(`SELECT * FROM control.audit_logs WHERE ($1::text IS NULL OR application_id = $1) ORDER BY at DESC, id DESC LIMIT 500`, [applicationId ?? null])).map(mapAudit);
}

/* ------------------------------------------------------------------ Phase 3C: authorization reads */

/** Roles for an authenticated subject (control.operator_roles). Unknown subject → null (no roles). */
export async function lookupOperatorRoles(subject: string) {
  const op = (await q<{ active: boolean }>(`SELECT active FROM control.operators WHERE id = $1`, [subject]))[0];
  if (!op) return null;
  const roles = (await q<{ role: string }>(`SELECT role FROM control.operator_roles WHERE operator_id = $1 ORDER BY role`, [subject])).map((r) => r.role);
  return { active: op.active, roles: roles.filter(isRole) };
}

/** True when any registered application is a production application (then anonymous reads are refused). */
export async function hasProductionApplications(): Promise<boolean> {
  return (await q<{ n: string }>(`SELECT count(*) n FROM control.applications WHERE environment = 'production'`))[0]!.n !== "0";
}

/** Read-only deletion-review bundle: evidence, approvals, authorizations and the approval-policy state. */
export async function getDeletionReview(jobId: string) {
  const client = await db().connect();
  try {
    const ev = await loadDeletionEvidence(client, jobId);
    if (!ev) return null;
    const settings = await loadSettings(client);
    const gaps = approvalPolicyGaps(settings);
    const approvals = await evaluateApprovals(client, ev, settings, new Date());
    return mapDeletionReview(ev, approvals.records, await listAuthorizations(client, jobId), settings, gaps);
  } finally {
    client.release();
  }
}
