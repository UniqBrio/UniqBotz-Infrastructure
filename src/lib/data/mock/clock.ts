/**
 * Demo clock. Mock timestamps are generated relative to the moment the mock
 * module loads so "last checked 2 min ago" stays meaningful during a review
 * session. Archive-candidate dates are fixed calendar dates.
 */
export const DEMO_NOW = new Date();

export function minutesAgo(min: number): string {
  return new Date(DEMO_NOW.getTime() - min * 60_000).toISOString();
}

export function hoursAgo(h: number): string {
  return minutesAgo(h * 60);
}

export function daysAgo(d: number, atHour?: number, atMinute = 0): string {
  const t = new Date(DEMO_NOW.getTime() - d * 86_400_000);
  if (atHour !== undefined) t.setHours(atHour, atMinute, 0, 0);
  return t.toISOString();
}

/** Last `n` complete calendar months (oldest first) as { month: YYYY-MM, days }. */
export function lastCompleteMonths(n: number): { month: string; days: number }[] {
  const out: { month: string; days: number }[] = [];
  const y = DEMO_NOW.getUTCFullYear();
  const m = DEMO_NOW.getUTCMonth();
  for (let i = n; i >= 1; i--) {
    const d = new Date(Date.UTC(y, m - i, 1));
    const days = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    out.push({ month: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`, days });
  }
  return out;
}

/** Deterministic PRNG so mock data is identical between reloads. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function dateRange(fromIso: string, toIso: string): string[] {
  const out: string[] = [];
  for (let d = fromIso; d <= toIso; d = addDays(d, 1)) out.push(d);
  return out;
}

export function monthsBefore(date: Date, months: number): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - months, date.getUTCDate()));
  return d.toISOString().slice(0, 10);
}
