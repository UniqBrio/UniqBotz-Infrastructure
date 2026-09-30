/**
 * UniqBotz archive worker — public surface.
 * Phase 3B: read-only monitoring + ARCHIVE_AND_VERIFY_ONLY. Deletion is implemented but refused unless
 * ALLOW_DELETION=true AND the application environment is allow-listed AND the kill switch is off AND …
 */
export * from "./config";
export * from "./connection/types";
export { EnvSecretResolver, SecretManager, EnvBackend, SecretError, SECRET_KINDS, type SecretKind, type SecretResolver } from "./connection/secrets";
export { openConnection, PINNED_SESSION } from "./connection/connect";
export { classifyError, isRecoverable } from "./connection/errors";
export { NestedTransactionError, beginOwned } from "./connection/transaction";
export { discoverDatabase, pickInsertionColumn } from "./discovery/catalog";
export { discoverEdges, findCycles, deletionOrder, validateSelection, graphHash, type FkEdge } from "./discovery/fkGraph";
export { describeTable, schemaHash } from "./schema/describe";
export { fingerprintSql, FINGERPRINT_ALGORITHM } from "./schema/fingerprint";
export * from "./retention/policy";
export { planGroup, eligibilityCutoffDay, localToday, type GroupSpec, type GroupPlan } from "./retention/group";
export { selectCandidate, dailyTotals } from "./candidates/selection";
export { previewCandidate, type CandidatePreview } from "./candidates/preview";
export { freezeAndExport, TargetNotReachedError } from "./archive/exporter";
export { LocalDirectoryStore, type ArchiveStore } from "./archive/store";
export * from "./archive/storage";
export { createArchiveStorage, LocalDirectoryStorage } from "./archive/providers";
export { CSV_GZ, formatById } from "./archive/format";
export { runVerificationGate, GATE_ORDER } from "./verification/gate";
export { evaluateDeletionGate } from "./deletion/gate";
export { deleteBatch, buildBatches } from "./deletion/batch";
export { createJob, cancelJob, DuplicateJobError, PolicyNotReadyError } from "./jobs/jobs";
export { JobRunner, type RunnerDeps } from "./jobs/runner";
export { CrashSignal, type CrashPoint } from "./jobs/faults";
export { collectApplication } from "./health/collector";
export { measureGrowth, growthWindow, detectSpikes } from "./health/growth";
export { migrateControlPlane, CONTROL_PLANE_TABLES } from "./controlplane/migrate";
export * from "./controlplane/repository";
export { audit } from "./audit/audit";
// Phase 3C
export * from "./readiness/blockers";
export * from "./approvals/approvals";
export * from "./controlplane/operators";
export { setKillSwitch, KillSwitchRefusedError } from "./controlplane/killSwitch";
export * from "./notifications/notifications";
export * from "./scheduling/scheduler";
export { WorkerLogger, redact, silentLogger } from "./observability/logger";
export { runReadOnlyDiscovery } from "./discovery/readOnlyDiscovery";
export { renderDiscoveryReport, auditWritePrivileges } from "./discovery/report";
