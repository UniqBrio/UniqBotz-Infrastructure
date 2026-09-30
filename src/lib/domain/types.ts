/**
 * Domain model for the UniqBotz central data-retention & archive control plane.
 *
 * These types are the contract between the UI and the data layer. In Phase 1 they
 * are satisfied by the mock data source (src/lib/data/mock); in later phases the
 * same shapes are returned by the real API/Supabase-backed source, so components
 * never need to change.
 */

export type ApplicationId = string;
export type ISODate = string; // YYYY-MM-DD
export type ISODateTime = string; // full ISO-8601 timestamp

/* ------------------------------------------------------------------ */
/* Severity & thresholds                                               */
/* ------------------------------------------------------------------ */

/** Alert levels. NONE = below the LOW threshold (no alert raised). */
export type Severity = "NONE" | "LOW" | "MEDIUM" | "HIGH";
export type AlertLevel = Exclude<Severity, "NONE">;

export interface RecordThresholds {
  /** 10 lakh records by default. */
  low: number;
  /** 11 lakh records by default. */
  medium: number;
  /** 12 lakh records by default. */
  high: number;
}

/**
 * Database-capacity thresholds (percent of plan capacity). These are NOT part of
 * the confirmed business rules — they are configurable demo defaults and are
 * labelled as such in the UI.
 */
export interface CapacityThresholdsPct {
  low: number;
  medium: number;
  high: number;
}

/* ------------------------------------------------------------------ */
/* Applications & tables                                               */
/* ------------------------------------------------------------------ */

export type ConnectionStatus = "connected" | "degraded" | "disconnected" | "not_configured";

export interface Application {
  id: ApplicationId;
  name: string;
  /** Short product description, for context only. */
  description: string;
  /** Supabase project reference. In mock mode this is a placeholder, never a real ref. */
  supabaseProjectRef: string;
  region: string;
  databaseSizeMb: number;
  databaseCapacityMb: number;
  connectionStatus: ConnectionStatus;
  lastHealthCheckAt: ISODateTime;
  registeredAt: ISODateTime;
}

export interface MonthlyGrowthPoint {
  /** YYYY-MM */
  month: string;
  recordsAdded: number;
  daysInMonth: number;
}

export interface TableSnapshot {
  applicationId: ApplicationId;
  tableName: string;
  schema: string;
  rowCount: number;
  estimatedSizeMb: number;
  indexSizeMb: number;
  /** Candidate date/timestamp columns discovered on the table. */
  dateColumns: string[];
  /** Last six complete months, oldest first. */
  monthlyGrowth: MonthlyGrowthPoint[];
  discoveredAt: ISODateTime;
  lastCheckedAt: ISODateTime;
}

export interface ThresholdStep {
  level: AlertLevel;
  threshold: number;
}

/** A table snapshot enriched with derived monitoring information. */
export interface TableHealth extends TableSnapshot {
  severity: Severity;
  /** Average records added per day across the last six months; null = INSUFFICIENT HISTORY (never inferred). */
  avgDailyGrowth6m: number | null;
  growthStatus?: "measured" | "insufficient_history";
  growthNote?: string;
  /** Whether rowCount is an exact count or a catalog estimate (live mode). */
  rowCountKind?: "exact" | "estimate";
  deadTuples?: number | null;
  nextThreshold: ThresholdStep | null;
  /** Records until nextThreshold is reached (null when above HIGH). */
  recordsRemaining: number | null;
  /** Informational projection only — see projectDaysToThreshold. */
  projectedDaysToNextThreshold: number | null;
  /** True when the table was discovered recently and still awaits an operator decision. */
  isNewlyDiscovered: boolean;
  policy: RetentionPolicyKind;
}

export type HealthStatus = "healthy" | "attention" | "critical" | "unknown";

export interface ApplicationHealth {
  application: Application;
  dbUsagePct: number;
  dbSeverity: Severity;
  tableSeverity: Severity;
  overallSeverity: Severity;
  status: HealthStatus;
  tableCount: number;
  largestTable: TableHealth | null;
  /** Sum over tables with a measured rate; null when no table has one (INSUFFICIENT HISTORY). */
  totalAvgDailyGrowth: number | null;
  /** True when at least one table has INSUFFICIENT HISTORY, so the total is a lower bound. */
  growthIncomplete?: boolean;
  tablesNeedingReview: number;
  tablesAtOrAboveLow: number;
}

/* ------------------------------------------------------------------ */
/* Retention policy                                                    */
/* ------------------------------------------------------------------ */

export type RetentionPolicyKind = "review_required" | "dont_archive" | "archive";

export interface RetentionPolicy {
  applicationId: ApplicationId;
  tableName: string;
  policy: RetentionPolicyKind;
  dateColumn: string | null;
  protectedPeriodMonths: number | null;
  archiveTargetRecords: number | null;
  enabled: boolean;
  updatedAt: ISODateTime;
  updatedBy: string;
}

export type RetentionPolicyInput = Omit<RetentionPolicy, "updatedAt" | "updatedBy">;

/* ------------------------------------------------------------------ */
/* Archive candidates                                                  */
/* ------------------------------------------------------------------ */

export interface CandidateDay {
  date: ISODate;
  /** Eligible record count per selected table for this date. */
  countsByTable: Record<string, number>;
}

export interface ArchiveCandidate {
  id: string;
  applicationId: ApplicationId;
  tables: string[];
  dateColumnByTable: Record<string, string>;
  target: number;
  protectedPeriodMonths: number;
  /** Records on/after this date are protected and never eligible. */
  protectedFrom: ISODate;
  /** Eligible days in ascending date order (preview data). */
  days: CandidateDay[];
  /** An in-flight job that must finish before this candidate can run. */
  blockedByJobId: string | null;
  /** Previous persisted archive boundary; the preview starts the day after. */
  previousBoundary: ISODate | null;
  generatedAt: ISODateTime;
  /** Live previews: rows NOT in the candidate and why. */
  excluded?: { reason: string; rows: number; detail: string }[];
  /** Live previews: computed read-only by the worker. */
  readOnly?: boolean;
  blocking?: string[];
}

/** Result of the day-wise cumulative selection rule. */
export interface WholeDaySelection {
  reachedTarget: boolean;
  selectedDays: CandidateDay[];
  oldestDate: ISODate | null;
  boundaryDate: ISODate | null;
  totalSelected: number;
  totalBeforeFinalDay: number;
  finalDayCount: number;
  /** Per-table totals across the selected days. */
  totalsByTable: Record<string, number>;
  /** Days that were eligible but not selected (after the boundary). */
  excludedDayCount: number;
}

/* ------------------------------------------------------------------ */
/* Archive jobs                                                        */
/* ------------------------------------------------------------------ */

export type ArchiveJobStatus =
  | "queued"
  | "preparing"
  | "selecting"
  | "exporting"
  | "verifying"
  | "ready_for_deletion"
  | "deletion_approved"
  | "deleting"
  | "verifying_deletion"
  | "waiting_retry"
  | "completed"
  | "completed_with_exceptions"
  | "failed"
  | "cancelled"
  | "requires_review";

export type PipelineStepKey =
  | "candidate_selection"
  | "candidate_frozen"
  | "archive_created"
  | "archive_verified"
  | "deletion"
  | "deletion_verified"
  | "completed";

export type PipelineStepStatus = "pending" | "running" | "passed" | "failed" | "blocked" | "awaiting_review";

export interface PipelineStep {
  key: PipelineStepKey;
  status: PipelineStepStatus;
  at: ISODateTime | null;
  recordCount: number | null;
  detail: string | null;
  error: string | null;
}

export type VerificationState = "pending" | "running" | "passed" | "failed";

export interface ArchiveVerification {
  state: VerificationState;
  expectedCount: number;
  verifiedCount: number | null;
  checksumMatch: boolean | null;
  error: string | null;
  verifiedAt: ISODateTime | null;
}

export type DeletionState =
  | "not_started"
  | "blocked"
  | "awaiting_review"
  | "in_progress"
  | "completed"
  | "halted";

export interface ArchiveDeletion {
  state: DeletionState;
  deletedCount: number;
  batchSize: number;
  batchesCompleted: number;
  batchesTotal: number;
}

export interface ArchiveJob {
  id: string;
  applicationId: ApplicationId;
  tables: string[];
  target: number;
  selected: number;
  selectedByTable: Record<string, number>;
  status: ArchiveJobStatus;
  progressPct: number;
  boundaryFrom: ISODate;
  boundaryTo: ISODate;
  createdAt: ISODateTime;
  startedAt: ISODateTime;
  finishedAt: ISODateTime | null;
  createdBy: string;
  archiveFormat: string;
  archiveSizeMb: number | null;
  /** Placeholder object-storage key; no storage exists in Phase 1. */
  archiveLocation: string | null;
  verification: ArchiveVerification;
  deletion: ArchiveDeletion;
  steps: PipelineStep[];
}

/* ------------------------------------------------------------------ */
/* Alerts                                                              */
/* ------------------------------------------------------------------ */

export type NotificationChannel = "whatsapp" | "email";
export type NotificationStatus = "sent" | "failed" | "suppressed" | "pending" | "not_configured";

export interface AlertNotification {
  channel: NotificationChannel;
  destination: string;
  status: NotificationStatus;
  at: ISODateTime | null;
  detail: string | null;
}

export type AlertState = "active" | "resolved";
export type AlertKind = "table_records" | "database_capacity";

export interface Alert {
  id: string;
  applicationId: ApplicationId;
  kind: AlertKind;
  /** Table name for record alerts; null for database-capacity alerts. */
  tableName: string | null;
  level: AlertLevel;
  state: AlertState;
  /** Observed value: records (table alerts) or MB (capacity alerts). */
  observedValue: number;
  threshold: number;
  avgDailyGrowth: number | null;
  detectedAt: ISODateTime;
  resolvedAt: ISODateTime | null;
  escalatedFrom: AlertLevel | null;
  notifications: AlertNotification[];
}

/* ------------------------------------------------------------------ */
/* Audit log                                                           */
/* ------------------------------------------------------------------ */

export type AuditAction =
  | "application_registered"
  | "discovery_completed"
  | "health_collected"
  | "collection_failed"
  | "policy_defaulted"
  | "candidate_preview"
  | "job_created"
  | "job_duplicate_rejected"
  | "candidate_selected"
  | "candidates_frozen"
  | "archive_created"
  | "deletion_approved"
  | "deletion_attempted"
  | "deletion_blocked"
  | "deletion_batch_completed"
  | "deletion_verified"
  | "job_retry_scheduled"
  | "job_resumed"
  | "job_requires_review"
  | "lease_takeover"
  | "operator_action"
  | "policy_created"
  | "policy_changed"
  | "table_discovered"
  | "archive_started"
  | "archive_verified"
  | "archive_verification_failed"
  | "deletion_started"
  | "deletion_completed"
  | "deletion_reviewed"
  | "job_failed"
  | "alert_sent"
  | "settings_changed"
  | "approval_recorded"
  | "approval_rejected"
  | "deletion_authorized"
  | "authorization_revoked"
  | "access_denied"
  | "kill_switch_changed"
  | "readiness_blocked"
  | "notification_suppressed"
  | "discovery_report";

export type AuditResult = "success" | "failure" | "blocked" | "simulated" | "info";

export interface AuditEntry {
  id: string;
  at: ISODateTime;
  applicationId: ApplicationId | null;
  action: AuditAction;
  tableName: string | null;
  actor: { type: "user" | "system" | "worker"; name: string };
  result: AuditResult;
  detail: string | null;
  jobId: string | null;
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export interface InfrastructureSettings {
  recordThresholds: RecordThresholds;
  capacityThresholdsPct: CapacityThresholdsPct;
  /** false until the business confirms capacity thresholds (shown as NOT FINAL). */
  capacityThresholdsFinal?: boolean;
  defaultArchiveTarget: number;
  notifications: {
    whatsappNumber: string;
    email: string;
    duplicateSuppressionHours: number;
    notifyOnEscalation: boolean;
    notifyOnRecovery: boolean;
  };
  safety: {
    /** Days of recent data held back beyond the protected period (late/backdated writes). null = not yet decided. */
    gracePeriodDays: number | null;
    /** Hard gate — cannot be disabled. Typed as `true` so the UI cannot express "off". */
    archiveVerificationRequired: true;
    deletionBatchSize: number;
    manualDeletionReviewRequired: boolean;
  };
  archiveFormat: "csv.gz" | "jsonl.gz" | "parquet";
  /** Days after discovery that a table is flagged as "new". */
  newTableWindowDays: number;
  /** Live mode only: effective runtime safety state reported by the control plane (read-only). */
  runtime?: {
    allowDeletion: boolean;
    deletionKillSwitch: boolean;
    schedulingEnabled: boolean;
    notificationsEnabled: boolean;
    policyEditing: "prototype" | "disabled_until_auth";
  };
}

/* ------------------------------------------------------------------ */
/* Phase 3C — session and deletion review                              */
/* ------------------------------------------------------------------ */

export type UserRole = "VIEWER" | "OPERATOR" | "APPROVER" | "ADMIN";

export interface SessionInfo {
  /** "mock" = prototype data; "disabled" = AUTHENTICATION NOT CONFIGURED; "jwt-hs256" = token-verified sessions. */
  authMode: "mock" | "disabled" | "jwt-hs256";
  authenticated: boolean;
  subject: string | null;
  email: string | null;
  roles: UserRole[];
  permissions: string[];
  notice: string | null;
  productionDeletion: "DISABLED";
}

export interface ReviewEvidence {
  attempt: number;
  manifestSha256: string | null;
  schemaHash: string | null;
  graphHash: string | null;
  candidateDigest: string | null;
}

export interface ReviewApproval {
  id: number;
  operator: string;
  decision: "approve" | "reject";
  comment: string | null;
  decidedAt: ISODateTime;
  expiresAt: ISODateTime | null;
  revokedAt: ISODateTime | null;
  counts: boolean;
  notCountingReason: string | null;
}

export interface ReviewAuthorization {
  id: number;
  operator: string;
  authorizedAt: ISODateTime;
  expiresAt: ISODateTime;
  revokedAt: ISODateTime | null;
  consumedAt: ISODateTime | null;
}

export interface DeletionReviewData {
  jobId: string;
  applicationId: ApplicationId;
  applicationName: string;
  environment: string;
  mode: string;
  status: string;
  tables: string[];
  candidateCount: number;
  rowsByTable: Record<string, number>;
  oldestDay: ISODate | null;
  boundaryDay: ISODate | null;
  evidence: ReviewEvidence;
  archiveLocation: string | null;
  archiveDataBytes: number;
  verification: { verified: boolean; verifiedAt: ISODateTime; failedStage: string | null; keySetPassed: boolean; restoreFingerprintPassed: boolean; schemaHashPassed: boolean } | null;
  candidateSetIntact: boolean;
  impact: { table: string; rowsToDelete: number; tableRows: number | null; pctOfTable: number | null; tableBytes: number | null; estReusableBytes: number | null }[];
  approvals: ReviewApproval[];
  authorizations: ReviewAuthorization[];
  policy: { requiredApprovers: number | null; approvalValidityMinutes: number | null; authorizationValidityMinutes: number | null; deletionWindow: string | null; gaps: string[] };
  /** Always "DISABLED" in Phase 3C: no approval or authorization can make the dashboard delete. */
  productionDeletion: "DISABLED";
  blockers: string[];
}
