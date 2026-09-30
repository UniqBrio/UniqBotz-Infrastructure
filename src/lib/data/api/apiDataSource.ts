import type {
  Alert, Application, ApplicationHealth, ApplicationId, ArchiveCandidate, ArchiveJob, AuditEntry,
  DeletionReviewData, InfrastructureSettings, RetentionPolicy, RetentionPolicyInput, ReviewEvidence, SessionInfo, TableHealth,
} from "@/lib/domain/types";
import { DataSourceError, type DeletionSimulationResult, type InfrastructureDataSource } from "../source";

/**
 * Browser-side live data source. Talks ONLY to the dashboard's own read-only API (/api/infra/*),
 * which reads the control plane server-side. No credentials ever reach the browser.
 */
export class ApiDataSource implements InfrastructureDataSource {
  readonly mode = "live" as const;
  /**
   * getToken supplies the identity provider's session token for WRITES (sent as a Bearer header, which is what
   * makes writes CSRF-safe). The provider is undecided (checklist S-1); without it every write is refused.
   */
  constructor(private base = "/api/infra", private getToken: () => Promise<string | null> = async () => null) {}

  private async get<T>(path: string, app?: ApplicationId): Promise<T> {
    const url = `${this.base}/${path}${app ? `?app=${encodeURIComponent(app)}` : ""}`;
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new DataSourceError(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `request failed (${r.status})`);
    return (await r.json()) as T;
  }

  private async refuse(path: string): Promise<never> {
    const r = await fetch(`${this.base}/${path}`, { method: "POST" });
    throw new DataSourceError(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "read-only");
  }

  listApplications() { return this.get<Application[]>("applications"); }
  listApplicationHealth() { return this.get<ApplicationHealth[]>("application-health"); }
  getApplicationHealth(id: ApplicationId) { return this.get<ApplicationHealth | null>(`application-health/${encodeURIComponent(id)}`); }
  listTables(app?: ApplicationId) { return this.get<TableHealth[]>("tables", app); }
  listRetentionPolicies(app?: ApplicationId) { return this.get<RetentionPolicy[]>("policies", app); }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- read-only: the input is intentionally ignored
  saveRetentionPolicy(_input: RetentionPolicyInput): Promise<RetentionPolicy> { return this.refuse("policies"); }
  listArchiveCandidates(app?: ApplicationId) { return this.get<ArchiveCandidate[]>("candidates", app); }
  listArchiveJobs(app?: ApplicationId) { return this.get<ArchiveJob[]>("jobs", app); }
  getArchiveJob(id: string) { return this.get<ArchiveJob | null>(`jobs/${encodeURIComponent(id)}`); }
  simulateDeletionConfirmation(jobId: string): Promise<DeletionSimulationResult> { return this.refuse(`jobs/${encodeURIComponent(jobId)}/delete`); }
  listAlerts(app?: ApplicationId) { return this.get<Alert[]>("alerts", app); }
  listAuditLog(app?: ApplicationId) { return this.get<AuditEntry[]>("audit", app); }
  getSettings() { return this.get<InfrastructureSettings>("settings"); }
  getSession() { return this.get<SessionInfo>("session"); }
  getDeletionReview(jobId: string) { return this.get<DeletionReviewData | null>(`jobs/${encodeURIComponent(jobId)}/review`); }
  async submitApprovalDecision(jobId: string, decision: "approve" | "reject", evidenceAck: ReviewEvidence, comment?: string): Promise<void> {
    const token = await this.getToken();
    const r = await fetch(`${this.base}/jobs/${encodeURIComponent(jobId)}/approvals`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ decision, evidenceAck, comment }),
    });
    if (!r.ok) throw new DataSourceError(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `request failed (${r.status})`);
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- read-only: the input is intentionally ignored
  updateSettings(_s: InfrastructureSettings): Promise<InfrastructureSettings> { return this.refuse("settings"); }
}
