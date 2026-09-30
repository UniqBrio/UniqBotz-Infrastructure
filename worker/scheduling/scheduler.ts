/**
 * Scheduling interface (Phase 3C §13). SCHEDULING DISABLED: nothing in this package starts a job on a timer.
 * evaluateScheduleEligibility() lists every reason a scheduled run would be refused, so the future scheduler
 * (decision SC-1) has a precise contract. Even a fully eligible schedule only ever creates an
 * ARCHIVE_AND_VERIFY_ONLY job; deletion always needs the separate approval + authorization path.
 */
export interface ScheduleEligibilityInput {
  schedulingEnabled: boolean; // system_settings.scheduling_enabled (constrained false in Phase 3C)
  policy: { policy: string; enabled: boolean; dateColumn: string | null; protectedPeriodMonths: number | null; targetRecords: number | null } | null;
  gracePeriodDays: number | null;
  applicationTimeZone: string | null;
  archiveStorageAvailable: boolean;
  previousVerification: "passed" | "failed" | "none";
  activeConflictingJob: string | null;
  capacityLevel: "NONE" | "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN";
  credentialsValid: boolean;
  /** Whether a first run (no previous verification) is allowed is itself undecided → treated as not allowed. */
  allowFirstRunWithoutVerification?: boolean;
}

export function evaluateScheduleEligibility(i: ScheduleEligibilityInput): { eligible: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!i.schedulingEnabled) reasons.push("SCHEDULING DISABLED");
  if (!i.policy || i.policy.policy !== "ARCHIVE" || !i.policy.enabled) reasons.push("retention policy is not an enabled ARCHIVE policy");
  else {
    if (!i.policy.dateColumn) reasons.push("RETENTION DATE COLUMN NOT CONFIGURED");
    if (i.policy.protectedPeriodMonths === null) reasons.push("PROTECTED PERIOD NOT CONFIGURED");
    if (i.policy.targetRecords === null) reasons.push("ARCHIVE TARGET NOT CONFIGURED");
  }
  if (i.gracePeriodDays === null) reasons.push("GRACE PERIOD NOT CONFIGURED");
  if (!i.applicationTimeZone) reasons.push("APPLICATION TIMEZONE NOT CONFIGURED");
  if (!i.archiveStorageAvailable) reasons.push("ARCHIVE EXECUTION UNAVAILABLE");
  if (i.previousVerification === "failed") reasons.push("previous archive verification failed — operator review required");
  if (i.previousVerification === "none" && !i.allowFirstRunWithoutVerification) reasons.push("no successful previous verification (first runs are manual)");
  if (i.activeConflictingJob) reasons.push(`active job ${i.activeConflictingJob} for this group`);
  if (i.capacityLevel === "UNKNOWN") reasons.push("database capacity health unknown");
  if (!i.credentialsValid) reasons.push("application credentials are not valid");
  return { eligible: reasons.length === 0, reasons };
}

export interface Scheduler {
  readonly enabled: false;
  /** Always refuses in Phase 3C. */
  start(): never;
}

export class DisabledScheduler implements Scheduler {
  readonly enabled = false as const;
  start(): never {
    throw new Error("SCHEDULING DISABLED: automated scheduling is not enabled in this deployment (Phase 3C)");
  }
}
