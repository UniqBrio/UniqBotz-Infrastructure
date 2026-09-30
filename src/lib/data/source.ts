import type {
  Alert,
  Application,
  ApplicationHealth,
  ApplicationId,
  ArchiveCandidate,
  ArchiveJob,
  AuditEntry,
  DeletionReviewData,
  InfrastructureSettings,
  ReviewEvidence,
  SessionInfo,
  RetentionPolicy,
  RetentionPolicyInput,
  TableHealth,
} from "@/lib/domain/types";

/** Outcome of the Phase-1 deletion walkthrough. Nothing is ever deleted. */
export interface DeletionSimulationResult {
  simulated: true;
  jobId: string;
  recordsThatWouldBeDeleted: number;
  recordsDeleted: 0;
  message: string;
}

/**
 * The single contract between the UI and its data. Every page reads through
 * this interface (via hooks in ./hooks.ts). Phase 1 ships `MockDataSource`;
 * the backend phase adds an API-backed implementation (e.g. Next.js route
 * handlers holding each application's Supabase credentials server-side) and
 * swaps it in `DataProvider` — no component changes required.
 */
export interface InfrastructureDataSource {
  readonly mode: "mock" | "live";

  listApplications(): Promise<Application[]>;
  listApplicationHealth(): Promise<ApplicationHealth[]>;
  getApplicationHealth(id: ApplicationId): Promise<ApplicationHealth | null>;

  listTables(applicationId?: ApplicationId): Promise<TableHealth[]>;

  listRetentionPolicies(applicationId?: ApplicationId): Promise<RetentionPolicy[]>;
  saveRetentionPolicy(input: RetentionPolicyInput): Promise<RetentionPolicy>;

  listArchiveCandidates(applicationId?: ApplicationId): Promise<ArchiveCandidate[]>;

  listArchiveJobs(applicationId?: ApplicationId): Promise<ArchiveJob[]>;
  getArchiveJob(id: string): Promise<ArchiveJob | null>;
  /** Phase 1: records a simulated confirmation only. Must never delete data. */
  simulateDeletionConfirmation(jobId: string): Promise<DeletionSimulationResult>;

  listAlerts(applicationId?: ApplicationId): Promise<Alert[]>;
  listAuditLog(applicationId?: ApplicationId): Promise<AuditEntry[]>;

  getSettings(): Promise<InfrastructureSettings>;
  updateSettings(settings: InfrastructureSettings): Promise<InfrastructureSettings>;

  /** Phase 3C: who is signed in, their roles and permissions (mock: no authentication). */
  getSession(): Promise<SessionInfo>;
  /** Phase 3C: evidence, approvals and authorization state for a job. null when not available (mock data). */
  getDeletionReview(jobId: string): Promise<DeletionReviewData | null>;
  /** Phase 3C: record an APPROVER decision bound to the reviewed evidence. Never deletes. */
  submitApprovalDecision(jobId: string, decision: "approve" | "reject", evidenceAck: ReviewEvidence, comment?: string): Promise<void>;
}

export class DataSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataSourceError";
  }
}
