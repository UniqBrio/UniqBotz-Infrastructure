/**
 * Worker configuration. Read from the environment ONLY on the server/worker side.
 *
 * HARD SAFETY DEFAULTS (Phase 3B):
 *   ALLOW_DELETION              false unless exactly "true"
 *   DELETION_ALLOWED_ENVIRONMENTS  "synthetic" only — even with ALLOW_DELETION=true the worker refuses to
 *                                  delete from any application whose declared environment is not listed.
 */
export type ApplicationEnvironment = "synthetic" | "staging" | "production";

export interface WorkerConfig {
  allowDeletion: boolean;
  deletionAllowedEnvironments: ApplicationEnvironment[];
  deletionBatchSize: number;
  maxDeletionBatchSize: number;
  leaseSeconds: number;
  verificationMaxAgeMinutes: number;
  archiveStoreDir: string;
  workerId: string;
  softwareVersion: string;
}

export const WORKER_SOFTWARE_VERSION = "uniqbotz-archive-worker/0.3.0-phase3b";

/** Phase 3A evidence: 2,000 kept transactions short; 10,000 degraded sharply. Not universally optimal. */
export const DEFAULT_BATCH_SIZE = 2_000;
export const MAX_BATCH_SIZE = 5_000;

export function parseAllowDeletion(value: string | undefined): boolean {
  return value === "true";
}

export function loadWorkerConfig(env: Record<string, string | undefined> = process.env): WorkerConfig {
  const batch = Number(env.DELETION_BATCH_SIZE ?? DEFAULT_BATCH_SIZE);
  if (!Number.isInteger(batch) || batch < 1 || batch > MAX_BATCH_SIZE) {
    throw new Error(`DELETION_BATCH_SIZE must be an integer between 1 and ${MAX_BATCH_SIZE}`);
  }
  const envs = (env.DELETION_ALLOWED_ENVIRONMENTS ?? "synthetic")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as ApplicationEnvironment[];
  if (envs.includes("production")) {
    throw new Error("Phase 3B: 'production' may not appear in DELETION_ALLOWED_ENVIRONMENTS");
  }
  return {
    allowDeletion: parseAllowDeletion(env.ALLOW_DELETION),
    deletionAllowedEnvironments: envs,
    deletionBatchSize: batch,
    maxDeletionBatchSize: MAX_BATCH_SIZE,
    leaseSeconds: Number(env.WORKER_LEASE_SECONDS ?? 30),
    verificationMaxAgeMinutes: Number(env.VERIFICATION_MAX_AGE_MINUTES ?? 24 * 60),
    archiveStoreDir: env.ARCHIVE_STORE_DIR ?? ".archive-store",
    workerId: env.WORKER_ID ?? `worker-${process.pid}`,
    softwareVersion: WORKER_SOFTWARE_VERSION,
  };
}
