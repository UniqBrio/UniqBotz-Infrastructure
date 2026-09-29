import type { InfrastructureSettings } from "@/lib/domain/types";

export const seedSettings: InfrastructureSettings = {
  recordThresholds: {
    low: 1_000_000, // 10 lakh
    medium: 1_100_000, // 11 lakh
    high: 1_200_000, // 12 lakh
  },
  // Configurable demo defaults — not confirmed business rules.
  capacityThresholdsPct: { low: 70, medium: 80, high: 90 },
  defaultArchiveTarget: 125_000,
  notifications: {
    whatsappNumber: "9994871158",
    email: "",
    duplicateSuppressionHours: 24,
    notifyOnEscalation: true,
    notifyOnRecovery: true,
  },
  safety: {
    gracePeriodDays: 7,
    archiveVerificationRequired: true,
    deletionBatchSize: 2_000,
    manualDeletionReviewRequired: true,
  },
  archiveFormat: "csv.gz",
  newTableWindowDays: 7,
};
