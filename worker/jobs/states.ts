export type JobStatus =
  | "queued" | "preparing" | "freezing" | "exporting" | "verifying" | "ready_for_deletion"
  | "deletion_approved" | "deleting" | "verifying_deletion" | "waiting_retry"
  | "completed" | "completed_with_exceptions" | "failed" | "cancelled" | "requires_review";

export type JobMode = "ARCHIVE_AND_VERIFY_ONLY" | "ARCHIVE_VERIFY_DELETE";

export const TERMINAL_STATUSES: JobStatus[] = ["completed", "completed_with_exceptions", "failed", "cancelled", "requires_review"];
/** Statuses the runner stops at, waiting for a human or time. */
export const PARKED_STATUSES: JobStatus[] = ["ready_for_deletion", "waiting_retry"];
export const DELETION_PHASE: JobStatus[] = ["deleting", "verifying_deletion"];
