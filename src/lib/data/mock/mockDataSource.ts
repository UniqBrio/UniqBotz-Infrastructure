import { deriveApplicationHealth, deriveTableHealth } from "@/lib/domain/health";
import { isDeletionAllowed } from "@/lib/domain/jobs";
import type {
  ApplicationId,
  AuditEntry,
  InfrastructureSettings,
  RetentionPolicy,
  RetentionPolicyInput,
  TableHealth,
} from "@/lib/domain/types";
import { DataSourceError, type DeletionSimulationResult, type InfrastructureDataSource } from "../source";
import { validateRetentionPolicy, validateSettings } from "../validation";
import { seedAlerts } from "./alerts";
import { seedApplications } from "./applications";
import { seedArchiveCandidates } from "./archiveCandidates";
import { seedArchiveJobs } from "./archiveJobs";
import { seedAuditLog } from "./auditLog";
import { DEMO_NOW } from "./clock";
import { defaultPolicyFor, seedRetentionPolicies } from "./retentionPolicies";
import { seedSettings } from "./settings";
import { seedTables } from "./tables";

export interface MockSimulationOptions {
  /** Artificial latency so loading states are visible during review. */
  latencyMs: number;
  /** Force every read to fail so error states can be reviewed. */
  failReads: boolean;
}

const DEMO_OPERATOR = "operator (demo session)";

function clone<T>(v: T): T {
  return structuredClone(v);
}

/**
 * In-memory, session-only implementation of the data contract.
 * - Reads return deep copies of seed data, with derived health computed
 *   from the current (editable) settings.
 * - Writes (policies, settings) mutate this in-memory copy only; a reload resets them.
 * - Nothing here connects to Supabase, storage, WhatsApp or any network service.
 */
export class MockDataSource implements InfrastructureDataSource {
  readonly mode = "mock" as const;

  private settings = clone(seedSettings);
  private policies = clone(seedRetentionPolicies);
  private audit = clone(seedAuditLog);
  private auditSeq = 0;
  simulation: MockSimulationOptions = { latencyMs: 250, failReads: false };

  /** Prototype-only review aid (Settings → Prototype controls). */
  setSimulation(patch: Partial<MockSimulationOptions>) {
    this.simulation = { ...this.simulation, ...patch };
  }

  private async read<T>(produce: () => T): Promise<T> {
    await new Promise((r) => setTimeout(r, this.simulation.latencyMs));
    if (this.simulation.failReads) {
      throw new DataSourceError("Simulated data-source failure (prototype control). No backend is connected.");
    }
    return clone(produce());
  }

  private async write<T>(produce: () => T): Promise<T> {
    await new Promise((r) => setTimeout(r, Math.min(400, this.simulation.latencyMs + 150)));
    return clone(produce());
  }

  private policyKind(applicationId: string, tableName: string) {
    return this.policies.find((p) => p.applicationId === applicationId && p.tableName === tableName)?.policy ?? "review_required";
  }

  private tables(applicationId?: ApplicationId): TableHealth[] {
    return seedTables
      .filter((t) => !applicationId || t.applicationId === applicationId)
      .map((t) => deriveTableHealth(t, this.policyKind(t.applicationId, t.tableName), this.settings, DEMO_NOW))
      .sort((a, b) => b.rowCount - a.rowCount);
  }

  private health(applicationId: ApplicationId) {
    const app = seedApplications.find((a) => a.id === applicationId);
    return app ? deriveApplicationHealth(app, this.tables(app.id), this.settings) : null;
  }

  private addAudit(entry: Omit<AuditEntry, "id" | "at">) {
    this.auditSeq += 1;
    this.audit.unshift({ ...entry, id: `AUD-LOCAL-${String(this.auditSeq).padStart(3, "0")}`, at: new Date().toISOString() });
  }

  listApplications() {
    return this.read(() => seedApplications);
  }

  listApplicationHealth() {
    return this.read(() => seedApplications.map((a) => this.health(a.id)!));
  }

  getApplicationHealth(id: ApplicationId) {
    return this.read(() => this.health(id));
  }

  listTables(applicationId?: ApplicationId) {
    return this.read(() => this.tables(applicationId));
  }

  listRetentionPolicies(applicationId?: ApplicationId) {
    return this.read(() =>
      seedTables
        .filter((t) => !applicationId || t.applicationId === applicationId)
        .map(
          (t) =>
            this.policies.find((p) => p.applicationId === t.applicationId && p.tableName === t.tableName) ??
            defaultPolicyFor(t.applicationId, t.tableName, t.discoveredAt),
        ),
    );
  }

  saveRetentionPolicy(input: RetentionPolicyInput) {
    return this.write<RetentionPolicy>(() => {
      const errors = validateRetentionPolicy(input);
      if (Object.keys(errors).length > 0) throw new DataSourceError(Object.values(errors).join(" "));
      const idx = this.policies.findIndex((p) => p.applicationId === input.applicationId && p.tableName === input.tableName);
      const previous = idx >= 0 ? this.policies[idx] : undefined;
      const next: RetentionPolicy = {
        ...input,
        // Non-archive policies never carry archive parameters.
        dateColumn: input.policy === "archive" ? input.dateColumn : null,
        protectedPeriodMonths: input.policy === "archive" ? input.protectedPeriodMonths : null,
        archiveTargetRecords: input.policy === "archive" ? input.archiveTargetRecords : null,
        enabled: input.policy === "archive" ? input.enabled : false,
        updatedAt: new Date().toISOString(),
        updatedBy: DEMO_OPERATOR,
      };
      if (idx >= 0) this.policies[idx] = next;
      else this.policies.push(next);
      const created = !previous || previous.policy === "review_required";
      this.addAudit({
        applicationId: input.applicationId,
        action: created ? "policy_created" : "policy_changed",
        tableName: input.tableName,
        actor: { type: "user", name: DEMO_OPERATOR },
        result: "simulated",
        detail: `Saved to local mock state: ${next.policy}${next.policy === "archive" ? ` · ${next.dateColumn} · ${next.protectedPeriodMonths} months · target ${next.archiveTargetRecords?.toLocaleString("en-US")} · ${next.enabled ? "enabled" : "disabled"}` : ""}.`,
        jobId: null,
      });
      return next;
    });
  }

  listArchiveCandidates(applicationId?: ApplicationId) {
    return this.read(() => seedArchiveCandidates.filter((c) => !applicationId || c.applicationId === applicationId));
  }

  listArchiveJobs(applicationId?: ApplicationId) {
    return this.read(() =>
      seedArchiveJobs
        .filter((j) => !applicationId || j.applicationId === applicationId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    );
  }

  getArchiveJob(id: string) {
    return this.read(() => seedArchiveJobs.find((j) => j.id === id) ?? null);
  }

  simulateDeletionConfirmation(jobId: string) {
    return this.write<DeletionSimulationResult>(() => {
      const job = seedArchiveJobs.find((j) => j.id === jobId);
      if (!job) throw new DataSourceError(`Unknown job ${jobId}.`);
      if (!isDeletionAllowed(job)) {
        this.addAudit({
          applicationId: job.applicationId,
          action: "deletion_reviewed",
          tableName: job.tables.join(", "),
          actor: { type: "user", name: DEMO_OPERATOR },
          result: "blocked",
          detail: "Deletion refused: archive verification has not passed. 0 records deleted.",
          jobId,
        });
        throw new DataSourceError("Deletion refused: archive verification has not passed. 0 records deleted.");
      }
      this.addAudit({
        applicationId: job.applicationId,
        action: "deletion_reviewed",
        tableName: job.tables.join(", "),
        actor: { type: "user", name: DEMO_OPERATOR },
        result: "simulated",
        detail: `Deletion confirmation simulated for ${job.selected.toLocaleString("en-US")} records. Phase 1 prototype — no records deleted.`,
        jobId,
      });
      return {
        simulated: true as const,
        jobId,
        recordsThatWouldBeDeleted: job.selected,
        recordsDeleted: 0 as const,
        message: "Simulation only. The prototype has no database connection — 0 records were deleted.",
      };
    });
  }

  listAlerts(applicationId?: ApplicationId) {
    return this.read(() =>
      seedAlerts
        .filter((a) => !applicationId || a.applicationId === applicationId)
        .sort((a, b) => b.detectedAt.localeCompare(a.detectedAt)),
    );
  }

  listAuditLog(applicationId?: ApplicationId) {
    return this.read(() =>
      this.audit
        .filter((a) => !applicationId || a.applicationId === applicationId)
        .sort((a, b) => b.at.localeCompare(a.at)),
    );
  }

  getSettings() {
    return this.read(() => this.settings);
  }

  updateSettings(next: InfrastructureSettings) {
    return this.write(() => {
      const errors = validateSettings(next);
      if (Object.keys(errors).length > 0) throw new DataSourceError(Object.values(errors).join(" "));
      this.settings = { ...clone(next), safety: { ...next.safety, archiveVerificationRequired: true } };
      this.addAudit({
        applicationId: null,
        action: "settings_changed",
        tableName: null,
        actor: { type: "user", name: DEMO_OPERATOR },
        result: "simulated",
        detail: "Settings saved to local mock state.",
        jobId: null,
      });
      return this.settings;
    });
  }
}
