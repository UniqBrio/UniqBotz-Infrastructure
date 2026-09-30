import type { ApplicationEnvironment, WorkerConfig } from "../config";

/**
 * Pure deletion gate. Deletion runs ONLY when this returns allowed=true. Every reason is reported,
 * not just the first, so an operator sees the full picture. Phase 3B defaults make it always refuse.
 */
export interface DeletionGateInput {
  config: Pick<WorkerConfig, "allowDeletion" | "deletionAllowedEnvironments" | "verificationMaxAgeMinutes">;
  environment: ApplicationEnvironment;
  killSwitch: boolean;
  jobStatus: string;
  jobMode: "ARCHIVE_AND_VERIFY_ONLY" | "ARCHIVE_VERIFY_DELETE";
  verification: { verified: boolean; attempt: number; verifiedAt: string } | null;
  currentAttempt: number;
  jobSchemaHash: string | null;
  liveSchemaHash: string | null;
  jobGraphHash: string | null;
  liveGraphHash: string | null;
  candidateSetIntact: boolean;
  now?: Date;
}

export function evaluateDeletionGate(i: DeletionGateInput): { allowed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!i.config.allowDeletion) reasons.push("ALLOW_DELETION=false (deletion is disabled in this deployment)");
  if (!i.config.deletionAllowedEnvironments.includes(i.environment)) reasons.push(`application environment '${i.environment}' is not in DELETION_ALLOWED_ENVIRONMENTS`);
  if (i.killSwitch) reasons.push("deletion kill switch is ON");
  if (i.jobMode !== "ARCHIVE_VERIFY_DELETE") reasons.push(`job mode is ${i.jobMode}`);
  if (!["deletion_approved", "deleting"].includes(i.jobStatus)) reasons.push(`job status is ${i.jobStatus} (requires deletion_approved)`);
  if (!i.verification) reasons.push("no archive verification recorded");
  else {
    if (!i.verification.verified) reasons.push("ARCHIVE VERIFICATION FAILED — DELETE = 0");
    if (i.verification.attempt !== i.currentAttempt) reasons.push("verification belongs to a different export attempt");
    const age = ((i.now ?? new Date()).getTime() - new Date(i.verification.verifiedAt).getTime()) / 60000;
    if (age > i.config.verificationMaxAgeMinutes) reasons.push(`verification is ${Math.round(age)} min old (max ${i.config.verificationMaxAgeMinutes}) — re-verify`);
  }
  if (!i.jobSchemaHash || i.liveSchemaHash !== i.jobSchemaHash) reasons.push("schema hash changed since freeze (or unknown)");
  if (!i.jobGraphHash || i.liveGraphHash !== i.jobGraphHash) reasons.push("FK graph changed since freeze (or unknown)");
  if (!i.candidateSetIntact) reasons.push("frozen candidate set failed its integrity check");
  return { allowed: reasons.length === 0, reasons };
}

export class DeletionRefusedError extends Error {
  constructor(public reasons: string[]) {
    super(`DELETION REFUSED (0 rows deleted): ${reasons.join("; ")}`);
    this.name = "DeletionRefusedError";
  }
}
