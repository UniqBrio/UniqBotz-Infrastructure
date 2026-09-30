/**
 * Error classification (Phase 3A F7): connection failures must become recoverable worker failures,
 * never process crashes.
 */
export type FailureKind =
  | "transient" // connection reset / unavailable — retry with backoff
  | "lock_timeout" // 55P03 — retry the batch
  | "statement_timeout" // 57014
  | "read_only" // 25006 — database in read-only mode: never auto-escape
  | "auth" // 28P01 / 28000 — credentials rejected or expired
  | "permission" // 42501
  | "schema" // 42P01 / 42703 — relation/column vanished
  | "configuration" // required configuration or secret missing (NotReadyError, SecretError, ARCHIVE EXECUTION UNAVAILABLE) — never retried
  | "storage" // archive storage operation failed (ArchiveStorageError) — retry with backoff
  | "permanent";

export function classifyError(e: unknown): FailureKind {
  const code = (e as { code?: string })?.code;
  const msg = String((e as { message?: string })?.message ?? e);
  const name = (e as { name?: string })?.name;
  if (name === "NotReadyError" || name === "SecretError" || name === "SecretResolutionError" || name === "ArchiveUnavailableError" || name === "ArchivePurgeDisabledError") return "configuration";
  if (name === "ArchiveStorageError") return "storage";
  if (code === "55P03") return "lock_timeout";
  if (code === "57014") return "statement_timeout";
  if (code === "25006") return "read_only";
  if (code === "28P01" || code === "28000") return "auth";
  if (code === "42501") return "permission";
  if (code === "42P01" || code === "42703") return "schema";
  if (code?.startsWith("08") || code === "57P01" || code === "57P02" || code === "57P03") return "transient";
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|Connection terminated|terminated unexpectedly|socket hang up/i.test(msg)) return "transient";
  return "permanent";
}

export function isRecoverable(kind: FailureKind): boolean {
  return kind === "transient" || kind === "lock_timeout" || kind === "statement_timeout" || kind === "auth" || kind === "storage";
}

export class RecoverableWorkerError extends Error {
  constructor(public kind: FailureKind, public cause: unknown) {
    super(`recoverable ${kind} failure: ${String((cause as Error)?.message ?? cause)}`);
    this.name = "RecoverableWorkerError";
  }
}
