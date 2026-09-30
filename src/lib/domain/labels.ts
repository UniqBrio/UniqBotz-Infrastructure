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
  queued: "Queued",
  preparing: "Preparing",
  selecting: "Selecting",
  exporting: "Exporting",
  verifying: "Verifying",
  ready_for_deletion: "Ready for Deletion",
  deletion_approved: "Deletion Approved",
  deleting: "Deleting",
  verifying_deletion: "Verifying Deletion",
  waiting_retry: "Waiting to Retry",
  completed: "Completed",
  completed_with_exceptions: "Completed (exceptions)",
  failed: "Failed",
  cancelled: "Cancelled",
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
  application_registered: "Application Registered",
  discovery_completed: "Discovery Completed",
  health_collected: "Health Collected",
  collection_failed: "Collection Failed",
  policy_defaulted: "Policy Defaulted (Review Required)",
  candidate_preview: "Candidate Preview (read-only)",
  job_created: "Job Created",
  job_duplicate_rejected: "Duplicate Job Rejected",
  candidate_selected: "Candidate Selected",
  candidates_frozen: "Candidates Frozen",
  archive_created: "Archive Created",
  deletion_approved: "Deletion Approved",
  deletion_attempted: "Deletion Attempted",
  deletion_blocked: "Deletion Blocked",
  deletion_batch_completed: "Deletion Batch Completed",
  deletion_verified: "Deletion Verified",
  job_retry_scheduled: "Retry Scheduled",
  job_resumed: "Job Resumed",
  job_requires_review: "Job Requires Review",
  lease_takeover: "Lease Takeover",
  operator_action: "Operator Action",
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
  approval_recorded: "Deletion Approval Recorded",
  approval_rejected: "Deletion Rejected by Approver",
  deletion_authorized: "Deletion Authorized (worker re-validates)",
  authorization_revoked: "Authorization Revoked",
  access_denied: "Access Denied",
  kill_switch_changed: "Kill Switch Changed",
  readiness_blocked: "Blocked — Configuration Missing",
  notification_suppressed: "Notification Suppressed (disabled)",
  discovery_report: "Read-only Discovery Report",
};

export const AUDIT_RESULT_LABEL: Record<AuditResult, string> = {
  success: "Success",
  failure: "Failure",
  blocked: "Blocked",
  simulated: "Simulated",
  info: "Info",
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
