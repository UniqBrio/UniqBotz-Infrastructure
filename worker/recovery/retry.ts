import { classifyError, isRecoverable, type FailureKind } from "../connection/errors";

export interface RetryDecision {
  kind: FailureKind;
  retry: boolean;
  delayMs: number;
}

/** Exponential backoff for recoverable failures; permanent failures are not retried. */
export function decideRetry(e: unknown, retryCount: number, maxRetries = 5, baseMs = 5_000): RetryDecision {
  const kind = classifyError(e);
  const retry = isRecoverable(kind) && retryCount < maxRetries;
  return { kind, retry, delayMs: retry ? Math.min(baseMs * 2 ** retryCount, 15 * 60_000) : 0 };
}
