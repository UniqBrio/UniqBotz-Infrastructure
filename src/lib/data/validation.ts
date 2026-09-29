import type { InfrastructureSettings, RetentionPolicyInput } from "@/lib/domain/types";

export type FieldErrors<K extends string = string> = Partial<Record<K, string>>;

export function validateRetentionPolicy(
  p: RetentionPolicyInput,
): FieldErrors<"dateColumn" | "protectedPeriodMonths" | "archiveTargetRecords" | "enabled"> {
  const errors: FieldErrors<"dateColumn" | "protectedPeriodMonths" | "archiveTargetRecords" | "enabled"> = {};
  if (p.policy !== "archive") {
    if (p.enabled) errors.enabled = "Only tables with the Archive policy can be enabled.";
    return errors;
  }
  if (!p.dateColumn) errors.dateColumn = "Choose the date column that defines each record's day.";
  if (p.protectedPeriodMonths === null || !Number.isInteger(p.protectedPeriodMonths) || p.protectedPeriodMonths < 1)
    errors.protectedPeriodMonths = "Protected period must be at least 1 whole month.";
  if (p.archiveTargetRecords === null || !Number.isInteger(p.archiveTargetRecords) || p.archiveTargetRecords < 1)
    errors.archiveTargetRecords = "Archive target must be a positive whole number of records.";
  return errors;
}

export function validateSettings(s: InfrastructureSettings): Record<string, string> {
  const errors: Record<string, string> = {};
  const t = s.recordThresholds;
  if (!(t.low > 0)) errors.low = "LOW must be greater than 0.";
  if (!(t.medium > t.low)) errors.medium = "MEDIUM must be greater than LOW.";
  if (!(t.high > t.medium)) errors.high = "HIGH must be greater than MEDIUM.";
  const c = s.capacityThresholdsPct;
  if (!(c.low > 0 && c.low < c.medium && c.medium < c.high && c.high <= 100))
    errors.capacity = "Capacity thresholds must increase LOW < MEDIUM < HIGH and stay within 1–100%.";
  if (!(s.defaultArchiveTarget > 0)) errors.defaultArchiveTarget = "Archive target must be positive.";
  if (!/^\+?\d{10,15}$/.test(s.notifications.whatsappNumber.replace(/\s/g, "")))
    errors.whatsappNumber = "Enter a 10–15 digit phone number.";
  if (s.notifications.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.notifications.email))
    errors.email = "Enter a valid email address or leave blank.";
  if (!(s.notifications.duplicateSuppressionHours >= 1)) errors.duplicateSuppressionHours = "Must be at least 1 hour.";
  if (!(s.safety.gracePeriodDays >= 0)) errors.gracePeriodDays = "Grace period cannot be negative.";
  if (!(s.safety.deletionBatchSize >= 100 && s.safety.deletionBatchSize <= 50_000))
    errors.deletionBatchSize = "Batch size must be between 100 and 50,000.";
  return errors;
}
