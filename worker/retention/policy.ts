/**
 * Retention policy model (control-plane side). Newly discovered tables are ALWAYS REVIEW_REQUIRED and
 * can never be archived until an operator sets ARCHIVE, configures it fully, and enables it.
 * There is NO default grace period baked in (ADR D-07): it is a configured value or the job refuses to plan.
 */
export type PolicyKind = "REVIEW_REQUIRED" | "DO_NOT_ARCHIVE" | "ARCHIVE";
export type PolicyStatus = "active" | "incomplete" | "invalid";
export const ARCHIVE_FORMATS = ["csv.gz"] as const;
export type ArchiveFormatId = (typeof ARCHIVE_FORMATS)[number];

export interface RetentionPolicyRecord {
  applicationId: string;
  schemaName: string;
  tableName: string;
  policy: PolicyKind;
  dateColumn: string | null;
  protectedPeriodMonths: number | null;
  targetRecords: number | null;
  gracePeriodDays: number | null; // null → use system default; if that is also null the table cannot be planned
  archiveFormat: ArchiveFormatId;
  timeZone: string | null; // null → application time zone
  enabled: boolean;
  /** Root table of the FK group this table is archived with (null → the table is its own root). */
  groupRoot: string | null;
  updatedBy: string;
  updatedAt: string;
}

export function defaultPolicy(applicationId: string, schemaName: string, tableName: string, at = new Date().toISOString()): RetentionPolicyRecord {
  return {
    applicationId,
    schemaName,
    tableName,
    policy: "REVIEW_REQUIRED",
    dateColumn: null,
    protectedPeriodMonths: null,
    targetRecords: null,
    gracePeriodDays: null,
    archiveFormat: "csv.gz",
    timeZone: null,
    enabled: false,
    groupRoot: null,
    updatedBy: "system:discovery",
    updatedAt: at,
  };
}

export interface PolicyContext {
  columns: { name: string; type: string }[];
  hasPrimaryKey: boolean;
  defaultGracePeriodDays: number | null;
}

/** Returns validation errors; an ARCHIVE policy may only be enabled when this returns []. */
export function validatePolicy(p: RetentionPolicyRecord, ctx: PolicyContext): string[] {
  const errors: string[] = [];
  if (p.policy !== "ARCHIVE") {
    if (p.enabled) errors.push("only ARCHIVE policies can be enabled");
    return errors;
  }
  if (!p.dateColumn) errors.push("date column is required");
  else {
    const col = ctx.columns.find((c) => c.name === p.dateColumn);
    if (!col) errors.push(`date column ${p.dateColumn} does not exist`);
    else if (!["date", "timestamp with time zone", "timestamp without time zone"].includes(col.type))
      errors.push(`date column ${p.dateColumn} is ${col.type}, not a date/timestamp type`);
  }
  if (!ctx.hasPrimaryKey) errors.push("table has no primary key — exact candidate identity is impossible");
  if (!Number.isInteger(p.protectedPeriodMonths) || (p.protectedPeriodMonths ?? 0) < 1) errors.push("protected period must be ≥ 1 month");
  if (!Number.isInteger(p.targetRecords) || (p.targetRecords ?? 0) < 1) errors.push("target must be a positive integer");
  const grace = p.gracePeriodDays ?? ctx.defaultGracePeriodDays;
  if (grace === null || !Number.isInteger(grace) || grace < 0) errors.push("grace period is not configured (no built-in default)");
  if (!ARCHIVE_FORMATS.includes(p.archiveFormat)) errors.push(`archive format ${p.archiveFormat} is not supported`);
  return errors;
}

export function policyStatus(p: RetentionPolicyRecord, ctx: PolicyContext): PolicyStatus {
  if (p.policy !== "ARCHIVE") return "active";
  return validatePolicy({ ...p, enabled: false }, ctx).length === 0 ? "active" : "incomplete";
}

/** Map to the Phase 1 UI vocabulary. */
export const POLICY_TO_UI = { REVIEW_REQUIRED: "review_required", DO_NOT_ARCHIVE: "dont_archive", ARCHIVE: "archive" } as const;
export const UI_TO_POLICY = { review_required: "REVIEW_REQUIRED", dont_archive: "DO_NOT_ARCHIVE", archive: "ARCHIVE" } as const;
