import type {
  ArchiveJobStatus,
  AuditAction,
  AuditResult,
  ConnectionStatus,
  NotificationStatus,
  PipelineStepKey,
  RetentionPolicyKind,
} from "./types";

export const POLICY_LABEL: Record<RetentionPolicyKind, string> = {
  review_required: "Review Required",
  dont_archive: "Don't Archive",
  archive: "Archive",
};

export const POLICY_DESCRIPTION: Record<RetentionPolicyKind, string> = {
  review_required: "Default for newly discovered or uncertain tables. Never archived.",
  dont_archive: "Operator decision: this table is never archived.",
  archive: "Eligible for the archive engine once enabled and fully configured.",
};

export const JOB_STATUS_LABEL: Record<ArchiveJobStatus, string> = {
  preparing: "Preparing",
  selecting: "Selecting",
  exporting: "Exporting",
  verifying: "Verifying",
  ready_for_deletion: "Ready for Deletion",
  deleting: "Deleting",
  completed: "Completed",
  failed: "Failed",
  requires_review: "Requires Review",
};

export const PIPELINE_STEP_LABEL: Record<PipelineStepKey, string> = {
  candidate_selection: "Candidate Selection",
  candidate_frozen: "Candidate Frozen",
  archive_created: "Archive Created",
  archive_verified: "Archive Verified",
  deletion: "Deletion",
  deletion_verified: "Deletion Verified",
  completed: "Completed",
};

export const AUDIT_ACTION_LABEL: Record<AuditAction, string> = {
  policy_created: "Policy Created",
  policy_changed: "Policy Changed",
  table_discovered: "Table Discovered",
  archive_started: "Archive Started",
  archive_verified: "Archive Verified",
  archive_verification_failed: "Archive Verification Failed",
  deletion_started: "Deletion Started",
  deletion_completed: "Deletion Completed",
  deletion_reviewed: "Deletion Reviewed",
  job_failed: "Job Failed",
  alert_sent: "Alert Sent",
  settings_changed: "Settings Changed",
};

export const AUDIT_RESULT_LABEL: Record<AuditResult, string> = {
  success: "Success",
  failure: "Failure",
  blocked: "Blocked",
  simulated: "Simulated",
};

export const CONNECTION_LABEL: Record<ConnectionStatus, string> = {
  connected: "Connected",
  degraded: "Degraded",
  disconnected: "Disconnected",
  not_configured: "Not configured",
};

export const NOTIFICATION_LABEL: Record<NotificationStatus, string> = {
  sent: "Sent",
  failed: "Failed",
  suppressed: "Suppressed (duplicate)",
  pending: "Pending",
  not_configured: "Not configured",
};
