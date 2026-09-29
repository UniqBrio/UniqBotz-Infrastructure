import type { RecordThresholds } from "@/lib/domain/types";
import { classifyRecords } from "@/lib/domain/severity";
import { formatInt, formatLakh } from "@/lib/domain/format";
import { cn } from "@/lib/cn";
import { TONE_DOT } from "@/components/ui/Badge";
import { SEVERITY_TONE } from "@/components/status/SeverityBadge";

/**
 * Horizontal record-count scale (from 0) showing where a table sits relative to
 * the LOW (10L) / MEDIUM (11L) / HIGH (12L) thresholds. Threshold bands are
 * tinted; a key underneath names each band so colour is never the only cue.
 */
export function ThresholdLadder({ rowCount, thresholds, className }: { rowCount: number; thresholds: RecordThresholds; className?: string }) {
  const max = Math.max(thresholds.high * 1.08, rowCount * 1.03);
  const pct = (n: number) => (n / max) * 100;
  const severity = classifyRecords(rowCount, thresholds);
  const steps = [
    { level: "LOW", value: thresholds.low, band: "bg-low-soft border-low-line" },
    { level: "MEDIUM", value: thresholds.medium, band: "bg-med-soft border-med-line" },
    { level: "HIGH", value: thresholds.high, band: "bg-high-soft border-high-line" },
  ] as const;

  return (
    <div className={cn("pt-5", className)}>
      <div
        className="relative h-2.5 rounded-full bg-neutral-soft"
        role="img"
        aria-label={`${formatInt(rowCount)} records; thresholds LOW ${formatInt(thresholds.low)}, MEDIUM ${formatInt(thresholds.medium)}, HIGH ${formatInt(thresholds.high)}`}
      >
        <div className="absolute inset-y-0 bg-low-soft" style={{ left: `${pct(thresholds.low)}%`, width: `${pct(thresholds.medium - thresholds.low)}%` }} />
        <div className="absolute inset-y-0 bg-med-soft" style={{ left: `${pct(thresholds.medium)}%`, width: `${pct(thresholds.high - thresholds.medium)}%` }} />
        <div className="absolute inset-y-0 rounded-r-full bg-high-soft" style={{ left: `${pct(thresholds.high)}%`, right: 0 }} />
        <div className={cn("absolute inset-y-0 left-0 rounded-full", TONE_DOT[SEVERITY_TONE[severity]])} style={{ width: `${pct(rowCount)}%` }} />
        <div
          className="num absolute -top-5 -translate-x-1/2 whitespace-nowrap text-[11px] font-semibold text-ink"
          style={{ left: `${Math.min(92, Math.max(8, pct(rowCount)))}%` }}
        >
          {formatInt(rowCount)}
        </div>
        {steps.map((s) => (
          <div key={s.level} aria-hidden className="absolute -top-1 h-4.5 w-px bg-ink-2" style={{ left: `${pct(s.value)}%` }} />
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[10px] text-ink-3">
        <span className="num">0</span>
        <span className="flex flex-wrap gap-x-3 gap-y-1">
          {steps.map((s) => (
            <span key={s.level} className="inline-flex items-center gap-1">
              <span aria-hidden className={cn("inline-block h-2 w-3 rounded-sm border", s.band)} />
              <span className="font-semibold text-ink-2">{s.level}</span> ≥ {formatLakh(s.value)}
            </span>
          ))}
        </span>
      </div>
    </div>
  );
}
