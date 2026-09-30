import type pg from "pg";

/** Auditable actions. Every destructive-capability event is recorded (Phase 3B §22). */
export type AuditAction =
  | "application_registered"
  | "discovery_completed"
  | "table_discovered"
  | "health_collected"
  | "collection_failed"
  | "policy_defaulted"
  | "policy_changed"
  | "candidate_preview"
  | "job_created"
  | "job_duplicate_rejected"
  | "candidate_selected"
  | "candidates_frozen"
  | "archive_created"
  | "archive_verified"
  | "archive_verification_failed"
  | "deletion_approved"
  | "deletion_attempted"
  | "deletion_blocked"
  | "deletion_batch_completed"
  | "deletion_completed"
  | "deletion_verified"
  | "job_retry_scheduled"
  | "job_resumed"
  | "job_failed"
  | "job_requires_review"
  | "lease_takeover"
  | "operator_action"
  // Phase 3C
  | "approval_recorded"
  | "approval_rejected"
  | "deletion_authorized"
  | "authorization_revoked"
  | "access_denied"
  | "kill_switch_changed"
  | "readiness_blocked"
  | "notification_suppressed"
  | "discovery_report";

export interface AuditEvent {
  action: AuditAction;
  result: "success" | "failure" | "blocked" | "simulated" | "info";
  applicationId?: string | null;
  jobId?: string | null;
  tableName?: string | null;
  actor?: { type: "user" | "system" | "worker"; name: string };
  detail?: unknown;
}

/** Append-only (enforced by trigger in the control plane). */
export async function audit(cp: pg.Client | pg.PoolClient, e: AuditEvent): Promise<void> {
  await cp.query(
    `INSERT INTO control.audit_logs (application_id, job_id, action, table_name, actor_type, actor_name, result, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [e.applicationId ?? null, e.jobId ?? null, e.action, e.tableName ?? null, e.actor?.type ?? "worker", e.actor?.name ?? "worker",
      e.result, e.detail === undefined ? null : JSON.stringify(e.detail)],
  );
}
