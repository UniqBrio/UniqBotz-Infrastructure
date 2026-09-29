import type { RetentionPolicy } from "@/lib/domain/types";
import { daysAgo } from "./clock";
import { seedPolicyHints, seedTables } from "./tables";

/**
 * Retention policies. Tables with no explicit operator decision fall back to
 * "Review Required" — the discovery step can never make a table archiveable.
 */
export function defaultPolicyFor(applicationId: string, tableName: string, discoveredAt: string): RetentionPolicy {
  return {
    applicationId,
    tableName,
    policy: "review_required",
    dateColumn: null,
    protectedPeriodMonths: null,
    archiveTargetRecords: null,
    enabled: false,
    updatedAt: discoveredAt,
    updatedBy: "system · table discovery",
  };
}

export const seedRetentionPolicies: RetentionPolicy[] = seedTables.map((t, i) => {
  const hint = seedPolicyHints.find((h) => h.applicationId === t.applicationId && h.tableName === t.tableName)?.policy;
  if (!hint) return defaultPolicyFor(t.applicationId, t.tableName, t.discoveredAt);
  return {
    applicationId: t.applicationId,
    tableName: t.tableName,
    policy: hint.kind,
    dateColumn: hint.dateColumn ?? null,
    protectedPeriodMonths: hint.protectedMonths ?? null,
    archiveTargetRecords: hint.target ?? null,
    enabled: hint.kind === "archive" ? hint.enabled ?? false : false,
    updatedAt: daysAgo(30 + ((i * 11) % 90), 11, 20),
    updatedBy: "ops@uniqbotz (demo)",
  };
});
