import type {
  AlertLevel,
  CapacityThresholdsPct,
  HealthStatus,
  RecordThresholds,
  Severity,
  ThresholdStep,
} from "./types";

export const SEVERITY_RANK: Record<Severity, number> = { NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };

export const ALERT_LEVELS: AlertLevel[] = ["LOW", "MEDIUM", "HIGH"];

export function maxSeverity(...levels: Severity[]): Severity {
  return levels.reduce<Severity>((acc, s) => (SEVERITY_RANK[s] > SEVERITY_RANK[acc] ? s : acc), "NONE");
}

/** Ordered threshold steps (LOW → HIGH). */
export function thresholdSteps(t: RecordThresholds): ThresholdStep[] {
  return [
    { level: "LOW", threshold: t.low },
    { level: "MEDIUM", threshold: t.medium },
    { level: "HIGH", threshold: t.high },
  ];
}

/** A value reaching a threshold is at that level (≥, not >). */
export function classifyRecords(records: number, t: RecordThresholds): Severity {
  if (records >= t.high) return "HIGH";
  if (records >= t.medium) return "MEDIUM";
  if (records >= t.low) return "LOW";
  return "NONE";
}

export function classifyCapacity(usagePct: number, t: CapacityThresholdsPct): Severity {
  if (usagePct >= t.high) return "HIGH";
  if (usagePct >= t.medium) return "MEDIUM";
  if (usagePct >= t.low) return "LOW";
  return "NONE";
}

export function nextThreshold(records: number, t: RecordThresholds): ThresholdStep | null {
  return thresholdSteps(t).find((s) => records < s.threshold) ?? null;
}

/**
 * Informational projection: days until `remaining` records are added at the
 * given average daily rate. Returns null when growth is zero/negative or there
 * is no next threshold. This is NOT a guarantee and must be presented as an estimate.
 */
export function projectDaysToThreshold(remaining: number | null, avgDailyGrowth: number): number | null {
  if (remaining === null || remaining <= 0) return remaining === null ? null : 0;
  if (!Number.isFinite(avgDailyGrowth) || avgDailyGrowth <= 0) return null;
  return Math.ceil(remaining / avgDailyGrowth);
}

export function healthStatusFor(severity: Severity): HealthStatus {
  switch (severity) {
    case "NONE":
      return "healthy";
    case "LOW":
    case "MEDIUM":
      return "attention";
    case "HIGH":
      return "critical";
  }
}
