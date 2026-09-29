import type { ApplicationHealth, CapacityThresholdsPct } from "@/lib/domain/types";
import { formatMb, formatPct } from "@/lib/domain/format";
import { DemoTag } from "@/components/ui/Badge";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { SeverityBadge, SEVERITY_TONE } from "@/components/status/SeverityBadge";

/** Database usage vs plan capacity, with the configurable capacity thresholds marked. */
export function DatabaseUsageCard({
  health,
  capacity,
  showThresholdNote = true,
}: {
  health: ApplicationHealth;
  capacity: CapacityThresholdsPct;
  showThresholdNote?: boolean;
}) {
  const a = health.application;
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">Database usage</div>
        <SeverityBadge severity={health.dbSeverity} />
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="num text-2xl font-semibold tracking-tight">{formatMb(a.databaseSizeMb)}</span>
        <span className="num text-sm text-ink-3">/ {formatMb(a.databaseCapacityMb)}</span>
        <span className="num ml-auto text-sm font-semibold text-ink-2">{formatPct(health.dbUsagePct)}</span>
      </div>
      <ProgressBar
        className="mt-2"
        value={health.dbUsagePct}
        tone={SEVERITY_TONE[health.dbSeverity]}
        label={`${a.name} database usage ${formatPct(health.dbUsagePct)}`}
        markers={[
          { at: capacity.low, label: `LOW ${capacity.low}%` },
          { at: capacity.medium, label: `MEDIUM ${capacity.medium}%` },
          { at: capacity.high, label: `HIGH ${capacity.high}%` },
        ]}
      />
      {showThresholdNote && (
        <p className="mt-1.5 flex flex-wrap items-center gap-1 text-[11px] text-ink-3">
          Capacity ticks at {capacity.low}% / {capacity.medium}% / {capacity.high}% — configurable demo defaults, not confirmed business rules.
          <DemoTag />
        </p>
      )}
    </div>
  );
}
