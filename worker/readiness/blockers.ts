/**
 * Fail-safe readiness vocabulary (Phase 3C §3). When a required value is missing the system refuses with one
 * of these exact messages — it NEVER substitutes a guessed value. The UI, audit log, CLI and tests all use
 * the same codes, so an operator sees the same words everywhere.
 */
export const BLOCKERS = {
  GRACE_PERIOD_NOT_CONFIGURED: "CANNOT RUN — GRACE PERIOD NOT CONFIGURED",
  APPLICATION_TIMEZONE_NOT_CONFIGURED: "CANNOT RUN — APPLICATION TIMEZONE NOT CONFIGURED",
  RETENTION_DATE_COLUMN_NOT_CONFIGURED: "CANNOT RUN — RETENTION DATE COLUMN NOT CONFIGURED",
  PROTECTED_PERIOD_NOT_CONFIGURED: "CANNOT RUN — PROTECTED PERIOD NOT CONFIGURED",
  TARGET_NOT_CONFIGURED: "CANNOT RUN — ARCHIVE TARGET NOT CONFIGURED",
  RETENTION_POLICY_NOT_CONFIGURED: "CANNOT RUN — RETENTION POLICY NOT CONFIGURED (REVIEW_REQUIRED)",
  ARCHIVE_EXECUTION_UNAVAILABLE: "ARCHIVE EXECUTION UNAVAILABLE",
  DELETION_NOT_AUTHORIZED: "DELETION NOT AUTHORIZED",
  APPROVAL_POLICY_NOT_CONFIGURED: "DELETION NOT AUTHORIZED — APPROVAL POLICY NOT CONFIGURED",
  DELETION_WINDOW_NOT_CONFIGURED: "DELETION NOT AUTHORIZED — DELETION TIME WINDOW NOT CONFIGURED",
  AUTHENTICATION_NOT_CONFIGURED: "AUTHENTICATION NOT CONFIGURED",
  SECRET_NOT_AVAILABLE: "CANNOT RUN — SECRET NOT AVAILABLE",
  SCHEDULING_DISABLED: "SCHEDULING DISABLED",
  NOTIFICATIONS_DISABLED: "NOTIFICATIONS DISABLED",
  PRODUCTION_DELETION_DISABLED: "PRODUCTION DELETION DISABLED",
} as const;

export type BlockerCode = keyof typeof BLOCKERS;

export function blockerMessage(code: BlockerCode, detail?: string): string {
  return detail ? `${BLOCKERS[code]}: ${detail}` : BLOCKERS[code];
}

/** Thrown when an operation cannot run because required configuration is missing. Never retried. */
export class NotReadyError extends Error {
  readonly codes: BlockerCode[];
  constructor(codes: BlockerCode | BlockerCode[], public detail?: string) {
    const list = [...new Set(Array.isArray(codes) ? codes : [codes])];
    super(list.map((c) => BLOCKERS[c]).join("; ") + (detail ? ` (${detail})` : ""));
    this.name = "NotReadyError";
    this.codes = list;
  }
}
