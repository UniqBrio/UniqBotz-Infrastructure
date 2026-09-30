/**
 * UniqBotz archive worker — public surface.
 * Phase 3B: read-only monitoring + ARCHIVE_AND_VERIFY_ONLY. Deletion is implemented but refused unless
 * ALLOW_DELETION=true AND the application environment is allow-listed AND the kill switch is off AND …
 */
export * from "./config";
export * from "./connection/types";
export { EnvSecretResolver, type SecretResolver } from "./connection/secrets";
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
export { CSV_GZ, formatById } from "./archive/format";
export { runVerificationGate, GATE_ORDER } from "./verification/gate";
export { evaluateDeletionGate } from "./deletion/gate";
export { deleteBatch, buildBatches } from "./deletion/batch";
export { createJob, approveDeletion, cancelJob, DuplicateJobError, PolicyNotReadyError } from "./jobs/jobs";
export { JobRunner, type RunnerDeps } from "./jobs/runner";
export { CrashSignal, type CrashPoint } from "./jobs/faults";
export { collectApplication } from "./health/collector";
export { measureGrowth, growthWindow, detectSpikes } from "./health/growth";
export { migrateControlPlane, CONTROL_PLANE_TABLES } from "./controlplane/migrate";
export * from "./controlplane/repository";
export { audit } from "./audit/audit";
