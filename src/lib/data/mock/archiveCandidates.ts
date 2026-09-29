import type { ArchiveCandidate, CandidateDay } from "@/lib/domain/types";
import { addDays, dateRange, DEMO_NOW, minutesAgo, monthsBefore, seededRandom } from "./clock";

/**
 * Archive-candidate previews. Daily counts are generated deterministically and
 * then pinned so the documented worked examples hold exactly:
 *
 *  • RosiFit attendance_records: 124,999 before the final day + 210 on 31 Jul 2024 = 125,209
 *  • Jalsa multi-table:          124,999 before the final day + 250 on 31 Jul 2025 = 125,249
 */

/** Spread `total` across `n` days with gentle random variation, summing exactly. */
function spread(total: number, n: number, seed: number): number[] {
  const rnd = seededRandom(seed);
  const weights = Array.from({ length: n }, (_, i) => {
    const weekday = i % 7 === 5 || i % 7 === 6 ? 0.7 : 1; // quieter weekends
    return weekday * (0.8 + rnd() * 0.4);
  });
  const sum = weights.reduce((a, b) => a + b, 0);
  const values = weights.map((w) => Math.max(1, Math.floor((w / sum) * total)));
  let diff = total - values.reduce((a, b) => a + b, 0);
  for (let i = 0; diff !== 0; i = (i + 1) % n) {
    const step = diff > 0 ? 1 : -1;
    const v = values[i] ?? 0;
    if (step < 0 && v <= 1) continue;
    values[i] = v + step;
    diff -= step;
  }
  return values;
}

function splitByRatio(total: number, ratios: Record<string, number>): Record<string, number> {
  const entries = Object.entries(ratios);
  const out: Record<string, number> = {};
  let used = 0;
  entries.forEach(([table, r], i) => {
    const v = i === entries.length - 1 ? total - used : Math.round(total * r);
    out[table] = v;
    used += v;
  });
  return out;
}

const protectedFrom12 = monthsBefore(DEMO_NOW, 12);
const protectedFrom6 = monthsBefore(DEMO_NOW, 6);

/* RosiFit — single table, continues from JOB-00124's boundary (2023-08-31). */
function rosifitDays(): CandidateDay[] {
  const before = dateRange("2023-09-01", "2024-07-30");
  const counts = spread(124_999, before.length, 17);
  const days: CandidateDay[] = before.map((date, i) => ({ date, countsByTable: { attendance_records: counts[i] ?? 0 } }));
  days.push({ date: "2024-07-31", countsByTable: { attendance_records: 210 } });
  // Following eligible days (not selected — shown as "after boundary").
  const after = dateRange("2024-08-01", "2024-08-14");
  spread(after.length * 395, after.length, 23).forEach((c, i) =>
    days.push({ date: after[i] ?? "", countsByTable: { attendance_records: c } }),
  );
  return days;
}

/* Jalsa — four related tables, final four days pinned to the documented example. */
function jalsaDays(): CandidateDay[] {
  const ratios = { orders: 0.286, order_items: 0.571, payments: 0.086, audit_logs: 0.057 };
  const pinned: CandidateDay[] = [
    { date: "2025-07-28", countsByTable: { orders: 400, order_items: 800, payments: 120, audit_logs: 80 } },
    { date: "2025-07-29", countsByTable: { orders: 380, order_items: 760, payments: 110, audit_logs: 72 } },
    { date: "2025-07-30", countsByTable: { orders: 410, order_items: 790, payments: 125, audit_logs: 90 } },
    { date: "2025-07-31", countsByTable: { orders: 60, order_items: 70, payments: 80, audit_logs: 40 } },
  ];
  const pinnedBeforeFinal = 1_400 + 1_322 + 1_415;
  const earlier = dateRange("2025-05-01", "2025-07-27");
  const totals = spread(124_999 - pinnedBeforeFinal, earlier.length, 41);
  const days: CandidateDay[] = earlier.map((date, i) => ({ date, countsByTable: splitByRatio(totals[i] ?? 0, ratios) }));
  days.push(...pinned);
  const after = dateRange("2025-08-01", "2025-08-10");
  spread(after.length * 1_410, after.length, 43).forEach((c, i) =>
    days.push({ date: after[i] ?? "", countsByTable: splitByRatio(c, ratios) }),
  );
  return days;
}

/* UniqBrio — eligible volume is below the target: the preview reports "target not reached". */
function uniqbrioDays(): CandidateDay[] {
  const end = addDays(protectedFrom6, -1);
  const start = addDays(end, -159);
  const range = dateRange(start, end);
  return spread(96_400, range.length, 59).map((c, i) => ({ date: range[i] ?? "", countsByTable: { notification_logs: c } }));
}

export const seedArchiveCandidates: ArchiveCandidate[] = [
  {
    id: "CAND-rosifit-attendance_records",
    applicationId: "rosifit",
    tables: ["attendance_records"],
    dateColumnByTable: { attendance_records: "attendance_date" },
    target: 125_000,
    protectedPeriodMonths: 12,
    protectedFrom: protectedFrom12,
    days: rosifitDays(),
    blockedByJobId: "JOB-00124",
    previousBoundary: "2023-08-31",
    generatedAt: minutesAgo(6),
  },
  {
    id: "CAND-jalsa-orders-group",
    applicationId: "jalsa",
    tables: ["orders", "order_items", "payments", "audit_logs"],
    dateColumnByTable: { orders: "order_date", order_items: "created_at", payments: "paid_at", audit_logs: "created_at" },
    target: 125_000,
    protectedPeriodMonths: 12,
    protectedFrom: protectedFrom12,
    days: jalsaDays(),
    blockedByJobId: null,
    previousBoundary: "2025-04-30",
    generatedAt: minutesAgo(4),
  },
  {
    id: "CAND-uniqbrio-notification_logs",
    applicationId: "uniqbrio",
    tables: ["notification_logs"],
    dateColumnByTable: { notification_logs: "sent_at" },
    target: 125_000,
    protectedPeriodMonths: 6,
    protectedFrom: protectedFrom6,
    days: uniqbrioDays(),
    blockedByJobId: null,
    previousBoundary: null,
    generatedAt: minutesAgo(9),
  },
];
