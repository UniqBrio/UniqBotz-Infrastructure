import type { Alert, AlertNotification } from "@/lib/domain/types";
import { daysAgo, DEMO_NOW, minutesAgo } from "./clock";
import { seedSettings } from "./settings";

const WA = seedSettings.notifications.whatsappNumber;

const wa = (status: AlertNotification["status"], at: string | null, detail: string | null = null): AlertNotification => ({
  channel: "whatsapp",
  destination: WA,
  status,
  at,
  detail,
});
const emailOff: AlertNotification = { channel: "email", destination: "—", status: "not_configured", at: null, detail: "No email destination configured." };

/** Today at hh:mm, or ~40 min ago if that time has not happened yet today. */
function todayAt(h: number, m: number): string {
  const t = daysAgo(0, h, m);
  return new Date(t) < DEMO_NOW ? t : minutesAgo(38);
}

export const ALERT_TODAY = todayAt(9, 42);

export const seedAlerts: Alert[] = [
  {
    id: "ALT-0412",
    applicationId: "jalsa",
    kind: "table_records",
    tableName: "orders",
    level: "HIGH",
    state: "active",
    observedValue: 1_204_821,
    threshold: 1_200_000,
    avgDailyGrowth: 3_240,
    detectedAt: todayAt(9, 42),
    resolvedAt: null,
    escalatedFrom: "MEDIUM",
    notifications: [wa("sent", todayAt(9, 42), "Escalation MEDIUM → HIGH"), emailOff],
  },
  {
    id: "ALT-0411",
    applicationId: "jalsa",
    kind: "database_capacity",
    tableName: null,
    level: "MEDIUM",
    state: "active",
    observedValue: 438,
    threshold: 400,
    avgDailyGrowth: null,
    detectedAt: daysAgo(1, 14, 5),
    resolvedAt: null,
    escalatedFrom: null,
    notifications: [wa("sent", daysAgo(1, 14, 5)), emailOff],
  },
  {
    id: "ALT-0410",
    applicationId: "rosifit",
    kind: "database_capacity",
    tableName: null,
    level: "MEDIUM",
    state: "active",
    observedValue: 412,
    threshold: 400,
    avgDailyGrowth: null,
    detectedAt: daysAgo(2, 8, 30),
    resolvedAt: null,
    escalatedFrom: "LOW",
    notifications: [
      wa("failed", daysAgo(2, 8, 30), "Provider timeout (demo). Retried automatically."),
      wa("sent", daysAgo(2, 8, 35), "Delivered on retry 1"),
      emailOff,
    ],
  },
  {
    id: "ALT-0409",
    applicationId: "jalsa",
    kind: "table_records",
    tableName: "order_items",
    level: "MEDIUM",
    state: "active",
    observedValue: 1_164_300,
    threshold: 1_100_000,
    avgDailyGrowth: 2_980,
    detectedAt: daysAgo(4, 11, 15),
    resolvedAt: null,
    escalatedFrom: "LOW",
    notifications: [wa("sent", daysAgo(4, 11, 15), "Escalation LOW → MEDIUM"), emailOff],
  },
  {
    id: "ALT-0405",
    applicationId: "jalsa",
    kind: "table_records",
    tableName: "payments",
    level: "LOW",
    state: "active",
    observedValue: 1_012_640,
    threshold: 1_000_000,
    avgDailyGrowth: 2_410,
    detectedAt: daysAgo(5, 9, 0),
    resolvedAt: null,
    escalatedFrom: null,
    notifications: [
      wa("sent", daysAgo(5, 9, 0)),
      wa("suppressed", daysAgo(4, 9, 0), "Same level within 24 h window — duplicate suppressed."),
      emailOff,
    ],
  },
  {
    id: "ALT-0398",
    applicationId: "jalsa",
    kind: "table_records",
    tableName: "orders",
    level: "MEDIUM",
    state: "resolved",
    observedValue: 1_131_900,
    threshold: 1_100_000,
    avgDailyGrowth: 3_190,
    detectedAt: daysAgo(22, 10, 0),
    resolvedAt: todayAt(9, 42),
    escalatedFrom: "LOW",
    notifications: [wa("sent", daysAgo(22, 10, 0)), emailOff],
  },
  {
    id: "ALT-0371",
    applicationId: "rosifit",
    kind: "table_records",
    tableName: "attendance_records",
    level: "LOW",
    state: "resolved",
    observedValue: 1_018_400,
    threshold: 1_000_000,
    avgDailyGrowth: 1_150,
    detectedAt: daysAgo(48, 7, 45),
    resolvedAt: daysAgo(34, 4, 40),
    escalatedFrom: null,
    notifications: [wa("sent", daysAgo(48, 7, 45)), wa("sent", daysAgo(34, 4, 40), "Recovery: back below LOW after JOB-00120"), emailOff],
  },
  {
    id: "ALT-0362",
    applicationId: "uniqbrio",
    kind: "table_records",
    tableName: "notification_logs",
    level: "LOW",
    state: "resolved",
    observedValue: 1_006_210,
    threshold: 1_000_000,
    avgDailyGrowth: 540,
    detectedAt: daysAgo(55, 12, 0),
    resolvedAt: daysAgo(41, 3, 0),
    escalatedFrom: null,
    notifications: [wa("sent", daysAgo(55, 12, 0)), wa("sent", daysAgo(41, 3, 0), "Recovery after JOB-00119"), emailOff],
  },
];

