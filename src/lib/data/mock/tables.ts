import type { MonthlyGrowthPoint, RetentionPolicyKind, TableSnapshot } from "@/lib/domain/types";
import { seedApplications } from "./applications";
import { daysAgo, lastCompleteMonths, minutesAgo } from "./clock";

interface TableSeed {
  name: string;
  rows: number;
  /** Target six-month average records/day. */
  growth: number;
  /** Growth trend across the six months (-0.3 = slowing, +0.3 = accelerating). */
  trend?: number;
  rowBytes: number;
  dateColumns: string[];
  discoveredDaysAgo?: number;
  /** Explicit operator policy. Omitted → table falls back to Review Required. */
  policy?: {
    kind: RetentionPolicyKind;
    dateColumn?: string;
    protectedMonths?: number;
    target?: number;
    enabled?: boolean;
  };
}

const SEEDS: Record<string, TableSeed[]> = {
  rosifit: [
    { name: "attendance_records", rows: 982_400, growth: 1_240, trend: 0.25, rowBytes: 180, dateColumns: ["attendance_date", "created_at"], policy: { kind: "archive", dateColumn: "attendance_date", protectedMonths: 12, target: 125_000, enabled: true } },
    { name: "workout_logs", rows: 612_300, growth: 860, trend: 0.15, rowBytes: 210, dateColumns: ["logged_at", "created_at"], policy: { kind: "archive", dateColumn: "logged_at", protectedMonths: 12, target: 125_000, enabled: true } },
    { name: "class_bookings", rows: 348_900, growth: 410, trend: 0.1, rowBytes: 140, dateColumns: ["class_date", "booked_at", "created_at"], policy: { kind: "archive", dateColumn: "class_date", protectedMonths: 18, target: 125_000, enabled: false } },
    { name: "notifications_outbox", rows: 204_110, growth: 380, trend: 0.3, rowBytes: 260, dateColumns: ["created_at", "sent_at"] },
    { name: "payments", rows: 18_420, growth: 22, rowBytes: 190, dateColumns: ["paid_at", "created_at"], policy: { kind: "dont_archive" } },
    { name: "trainer_feedback", rows: 4_210, growth: 9, rowBytes: 320, dateColumns: ["submitted_at", "created_at"], discoveredDaysAgo: 2 },
    { name: "members", rows: 1_200, growth: 10, rowBytes: 420, dateColumns: ["joined_on", "created_at"], policy: { kind: "dont_archive" } },
    { name: "courses", rows: 35, growth: 0, rowBytes: 380, dateColumns: ["created_at"], policy: { kind: "dont_archive" } },
  ],
  uniqbrio: [
    { name: "session_logs", rows: 742_160, growth: 690, trend: 0.1, rowBytes: 150, dateColumns: ["session_date", "created_at"], policy: { kind: "archive", dateColumn: "session_date", protectedMonths: 18, target: 125_000, enabled: true } },
    { name: "attendance", rows: 505_340, growth: 520, trend: 0.05, rowBytes: 120, dateColumns: ["attendance_date", "created_at"], policy: { kind: "archive", dateColumn: "attendance_date", protectedMonths: 12, target: 125_000, enabled: true } },
    { name: "notification_logs", rows: 388_900, growth: 610, trend: 0.2, rowBytes: 200, dateColumns: ["sent_at", "created_at"], policy: { kind: "archive", dateColumn: "sent_at", protectedMonths: 6, target: 125_000, enabled: true } },
    { name: "audit_events", rows: 221_500, growth: 300, rowBytes: 240, dateColumns: ["occurred_at", "created_at"] },
    { name: "chat_messages", rows: 96_420, growth: 240, trend: 0.4, rowBytes: 280, dateColumns: ["sent_at", "created_at"], discoveredDaysAgo: 1 },
    { name: "fee_payments", rows: 41_200, growth: 55, rowBytes: 180, dateColumns: ["paid_on", "created_at"], policy: { kind: "dont_archive" } },
    { name: "enrollments", rows: 26_880, growth: 38, rowBytes: 160, dateColumns: ["enrolled_on", "created_at"], policy: { kind: "dont_archive" } },
    { name: "assessments", rows: 12_640, growth: 20, rowBytes: 300, dateColumns: ["assessed_on", "created_at"] },
    { name: "students", rows: 8_420, growth: 14, rowBytes: 460, dateColumns: ["joined_on", "created_at"], policy: { kind: "dont_archive" } },
    { name: "batches", rows: 1_204, growth: 2, rowBytes: 220, dateColumns: ["starts_on", "created_at"], policy: { kind: "dont_archive" } },
    { name: "instructors", rows: 312, growth: 1, rowBytes: 400, dateColumns: ["created_at"], policy: { kind: "dont_archive" } },
    { name: "courses", rows: 146, growth: 0, rowBytes: 520, dateColumns: ["created_at"], policy: { kind: "dont_archive" } },
  ],
  jalsa: [
    { name: "orders", rows: 1_204_821, growth: 3_240, trend: 0.2, rowBytes: 120, dateColumns: ["order_date", "created_at"], policy: { kind: "archive", dateColumn: "order_date", protectedMonths: 12, target: 125_000, enabled: true } },
    { name: "order_items", rows: 1_164_300, growth: 2_980, trend: 0.2, rowBytes: 90, dateColumns: ["created_at"], policy: { kind: "archive", dateColumn: "created_at", protectedMonths: 12, target: 125_000, enabled: true } },
    { name: "payments", rows: 1_012_640, growth: 2_410, trend: 0.15, rowBytes: 80, dateColumns: ["paid_at", "created_at"], policy: { kind: "archive", dateColumn: "paid_at", protectedMonths: 12, target: 125_000, enabled: true } },
    { name: "audit_logs", rows: 684_200, growth: 1_870, trend: 0.1, rowBytes: 110, dateColumns: ["created_at"], policy: { kind: "archive", dateColumn: "created_at", protectedMonths: 6, target: 125_000, enabled: true } },
    { name: "kitchen_tickets", rows: 512_330, growth: 1_120, rowBytes: 100, dateColumns: ["printed_at", "created_at"] },
    { name: "inventory_movements", rows: 402_880, growth: 760, rowBytes: 110, dateColumns: ["moved_at", "created_at"] },
    { name: "delivery_partner_events", rows: 148_220, growth: 460, trend: 0.5, rowBytes: 150, dateColumns: ["event_time", "created_at"], discoveredDaysAgo: 3 },
    { name: "reservations", rows: 96_540, growth: 140, rowBytes: 170, dateColumns: ["reserved_for", "created_at"], policy: { kind: "archive", dateColumn: "reserved_for", protectedMonths: 24, target: 125_000, enabled: false } },
    { name: "customers", rows: 58_210, growth: 84, rowBytes: 260, dateColumns: ["created_at"], policy: { kind: "dont_archive" } },
    { name: "shifts", rows: 12_900, growth: 18, rowBytes: 120, dateColumns: ["shift_date", "created_at"], policy: { kind: "dont_archive" } },
    { name: "coupons", rows: 1_240, growth: 3, rowBytes: 200, dateColumns: ["valid_until", "created_at"], policy: { kind: "dont_archive" } },
    { name: "menu_items", rows: 412, growth: 2, rowBytes: 380, dateColumns: ["created_at"], policy: { kind: "dont_archive" } },
    { name: "staff", rows: 64, growth: 0, rowBytes: 400, dateColumns: ["joined_on", "created_at"], policy: { kind: "dont_archive" } },
    { name: "restaurant_tables", rows: 42, growth: 0, rowBytes: 120, dateColumns: ["created_at"], policy: { kind: "dont_archive" } },
    { name: "categories", rows: 38, growth: 0, rowBytes: 160, dateColumns: ["created_at"], policy: { kind: "dont_archive" } },
  ],
};

/** Six monthly points whose day-weighted average is exactly `avgPerDay`. */
function growthSeries(avgPerDay: number, trend: number): MonthlyGrowthPoint[] {
  const months = lastCompleteMonths(6);
  const totalDays = months.reduce((a, m) => a + m.days, 0);
  const points = months.map((m, i) => {
    const factor = 1 + (trend * (i - 2.5)) / 2.5;
    return { month: m.month, daysInMonth: m.days, recordsAdded: Math.round(avgPerDay * factor * m.days) };
  });
  const desired = avgPerDay * totalDays;
  const drift = desired - points.reduce((a, p) => a + p.recordsAdded, 0);
  const last = points[points.length - 1];
  if (last) last.recordsAdded = Math.max(0, last.recordsAdded + drift);
  return points;
}

function buildSnapshots(): TableSnapshot[] {
  const out: TableSnapshot[] = [];
  for (const app of seedApplications) {
    const seeds = SEEDS[app.id] ?? [];
    // Scale estimated sizes so heap + index totals ~92% of the reported database size.
    const weight = seeds.reduce((a, s) => a + s.rows * s.rowBytes * 1.35, 0);
    const scale = weight > 0 ? (app.databaseSizeMb * 0.92) / weight : 0;
    seeds.forEach((s, i) => {
      const total = s.rows * s.rowBytes * 1.35 * scale;
      out.push({
        applicationId: app.id,
        tableName: s.name,
        schema: "public",
        rowCount: s.rows,
        estimatedSizeMb: Math.max(0.02, round2(total / 1.35)),
        indexSizeMb: Math.max(0.01, round2(total - total / 1.35)),
        dateColumns: s.dateColumns,
        monthlyGrowth: growthSeries(s.growth, s.trend ?? 0),
        discoveredAt: s.discoveredDaysAgo !== undefined ? daysAgo(s.discoveredDaysAgo, 3, 10) : app.registeredAt,
        lastCheckedAt: minutesAgo(1 + ((i * 7) % 4)),
      });
    });
  }
  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export const seedTables: TableSnapshot[] = buildSnapshots();

export const seedPolicyHints: { applicationId: string; tableName: string; policy: TableSeed["policy"] }[] =
  Object.entries(SEEDS).flatMap(([applicationId, seeds]) =>
    seeds.map((s) => ({ applicationId, tableName: s.name, policy: s.policy })),
  );
