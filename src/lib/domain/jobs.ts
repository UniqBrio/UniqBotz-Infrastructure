import type { ArchiveJob, ArchiveJobStatus, PipelineStepKey } from "./types";

export const ACTIVE_JOB_STATUSES: ArchiveJobStatus[] = [
  "preparing",
  "selecting",
  "exporting",
  "verifying",
  "ready_for_deletion",
  "deleting",
];

export const TERMINAL_JOB_STATUSES: ArchiveJobStatus[] = ["completed", "failed", "requires_review"];

export const PIPELINE_ORDER: PipelineStepKey[] = [
  "candidate_selection",
  "candidate_frozen",
  "archive_created",
  "archive_verified",
  "deletion",
  "deletion_verified",
  "completed",
];

export function isActiveJob(job: ArchiveJob): boolean {
  return ACTIVE_JOB_STATUSES.includes(job.status);
}

/**
 * The hard safety gate. Deletion may only be reviewed/confirmed when the archive
 * has been verified. Any other verification state means zero records may be deleted.
 */
export function isDeletionAllowed(job: ArchiveJob): boolean {
  return job.verification.state === "passed" && job.verification.checksumMatch === true
    && job.verification.verifiedCount === job.verification.expectedCount;
}

export function canReviewDeletion(job: ArchiveJob): boolean {
  return job.status === "ready_for_deletion" && isDeletionAllowed(job) && job.deletion.state === "awaiting_review";
}
