const intFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const lakhFmt = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

export function formatInt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return intFmt.format(n);
}

/** Indian digit grouping (e.g. 9,82,400) — used alongside lakh terminology. */
export function formatIndian(n: number): string {
  return lakhFmt.format(n);
}

/** "10 lakh", "11 lakh", "12.5 lakh" */
export function formatLakh(n: number): string {
  const l = n / 100_000;
  return `${Number.isInteger(l) ? l : l.toFixed(1)} lakh`;
}

export function formatCompact(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

export function formatPct(n: number, digits = 1): string {
  return `${n.toFixed(digits)}%`;
}

export function formatMb(mb: number | null | undefined): string {
  if (mb === null || mb === undefined) return "—";
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  if (mb < 1) return `${Math.round(mb * 1024)} KB`;
  return `${mb % 1 === 0 ? mb : mb.toFixed(1)} MB`;
}

const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
const shortDateFmt = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });
const dateTimeFmt = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const monthFmt = new Intl.DateTimeFormat("en-GB", { month: "short", year: "2-digit", timeZone: "UTC" });

/** YYYY-MM-DD → "31 Jul 2024" */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return dateFmt.format(new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso));
}

export function formatShortDate(iso: string): string {
  return shortDateFmt.format(new Date(`${iso}T00:00:00Z`));
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return dateTimeFmt.format(new Date(iso));
}

/** YYYY-MM → "Apr 26" */
export function formatMonth(ym: string): string {
  return monthFmt.format(new Date(`${ym}-01T00:00:00Z`));
}

export function formatRelative(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "—";
  const diffSec = Math.round((now.getTime() - new Date(iso).getTime()) / 1000);
  if (diffSec < 45) return "just now";
  const min = Math.round(diffSec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} h ago`;
  const d = Math.round(hr / 24);
  if (d < 30) return `${d} d ago`;
  return formatDate(iso);
}

export function formatDays(days: number | null): string {
  if (days === null) return "—";
  if (days === 0) return "Reached";
  if (days > 3650) return "> 10 years";
  return `~${formatInt(days)} days`;
}
