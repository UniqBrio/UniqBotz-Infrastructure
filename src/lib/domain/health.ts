import {
  classifyCapacity,
  classifyRecords,
  healthStatusFor,
  maxSeverity,
  nextThreshold,
  projectDaysToThreshold,
} from "./severity";
import type {
  Application,
  ApplicationHealth,
  InfrastructureSettings,
  MonthlyGrowthPoint,
  RetentionPolicyKind,
  TableHealth,
  TableSnapshot,
} from "./types";

/** Average records/day over the supplied months (weighted by days in month). */
export function averageDailyGrowth(points: MonthlyGrowthPoint[]): number {
  const days = points.reduce((a, p) => a + p.daysInMonth, 0);
  if (days === 0) return 0;
  const added = points.reduce((a, p) => a + p.recordsAdded, 0);
  return Math.round(added / days);
}

export function deriveTableHealth(
  snapshot: TableSnapshot,
  policy: RetentionPolicyKind,
  settings: InfrastructureSettings,
  now: Date,
): TableHealth {
  const t = settings.recordThresholds;
  const avg = averageDailyGrowth(snapshot.monthlyGrowth);
  const next = nextThreshold(snapshot.rowCount, t);
  const remaining = next ? next.threshold - snapshot.rowCount : null;
  const ageDays = (now.getTime() - new Date(snapshot.discoveredAt).getTime()) / 86_400_000;
  return {
    ...snapshot,
    severity: classifyRecords(snapshot.rowCount, t),
    avgDailyGrowth6m: avg,
    growthStatus: "measured",
    nextThreshold: next,
    recordsRemaining: remaining,
    projectedDaysToNextThreshold: projectDaysToThreshold(remaining, avg),
    isNewlyDiscovered: ageDays <= settings.newTableWindowDays,
    policy,
  };
}

export function deriveApplicationHealth(
  application: Application,
  tables: TableHealth[],
  settings: InfrastructureSettings,
): ApplicationHealth {
  const dbUsagePct = (application.databaseSizeMb / application.databaseCapacityMb) * 100;
  const dbSeverity = classifyCapacity(dbUsagePct, settings.capacityThresholdsPct);
  const tableSeverity = maxSeverity(...tables.map((t) => t.severity));
  const overallSeverity = maxSeverity(dbSeverity, tableSeverity);
  const largestTable = tables.reduce<TableHealth | null>(
    (acc, t) => (acc === null || t.rowCount > acc.rowCount ? t : acc),
    null,
  );
  const status = application.connectionStatus === "connected" ? healthStatusFor(overallSeverity) : "unknown";
  return {
    application,
    dbUsagePct,
    dbSeverity,
    tableSeverity,
    overallSeverity,
    status,
    tableCount: tables.length,
    largestTable,
    totalAvgDailyGrowth: tables.some((t) => t.avgDailyGrowth6m !== null) ? tables.reduce((a, t) => a + (t.avgDailyGrowth6m ?? 0), 0) : null,
    growthIncomplete: tables.some((t) => t.avgDailyGrowth6m === null),
    tablesNeedingReview: tables.filter((t) => t.policy === "review_required").length,
    tablesAtOrAboveLow: tables.filter((t) => t.severity !== "NONE").length,
  };
}
