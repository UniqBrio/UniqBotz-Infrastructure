import type { CandidateDay, WholeDaySelection } from "./types";

export function dayTotal(day: CandidateDay): number {
  return Object.values(day.countsByTable).reduce((a, b) => a + b, 0);
}

/**
 * Day-wise cumulative archive selection (preview implementation of the rule
 * described in the architecture document, §5):
 *
 *  1. Start at the oldest eligible date and process dates in ascending order.
 *  2. For each date include ALL eligible records from EVERY selected table.
 *  3. Add the complete day's records to the running total.
 *  4. Stop as soon as the target is reached or crossed.
 *  5. Never take only part of a day — the final day is always included whole.
 *
 * Phase 1 uses this purely to render mock previews. The authoritative
 * calculation will run server-side against the source database.
 */
export function selectWholeDays(days: CandidateDay[], target: number): WholeDaySelection {
  const ordered = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const selectedDays: CandidateDay[] = [];
  const totalsByTable: Record<string, number> = {};
  let running = 0;
  let before = 0;
  let reachedTarget = false;

  for (const day of ordered) {
    if (running >= target) break;
    const total = dayTotal(day);
    before = running;
    running += total;
    selectedDays.push(day);
    for (const [table, count] of Object.entries(day.countsByTable)) {
      totalsByTable[table] = (totalsByTable[table] ?? 0) + count;
    }
    if (running >= target) {
      reachedTarget = true;
      break;
    }
  }

  const last = selectedDays[selectedDays.length - 1];
  return {
    reachedTarget,
    selectedDays,
    oldestDate: selectedDays[0]?.date ?? null,
    boundaryDate: last?.date ?? null,
    totalSelected: running,
    totalBeforeFinalDay: last ? before : 0,
    finalDayCount: last ? dayTotal(last) : 0,
    totalsByTable,
    excludedDayCount: ordered.length - selectedDays.length,
  };
}

/** Running totals for each selected day, for timeline rendering. */
export function runningTotals(days: CandidateDay[]): { day: CandidateDay; total: number; cumulative: number }[] {
  let cumulative = 0;
  return days.map((day) => {
    const total = dayTotal(day);
    cumulative += total;
    return { day, total, cumulative };
  });
}
