import { Info } from "lucide-react";
import type { RecordThresholds, TableHealth } from "@/lib/domain/types";
import { formatDays, formatInt, formatLakh, formatRelative } from "@/lib/domain/format";
import { Card } from "@/components/ui/Card";
import { KeyValueList } from "@/components/ui/KeyValue";
import { SeverityBadge } from "@/components/status/SeverityBadge";
import { GrowthChart } from "./GrowthChart";
import { ThresholdLadder } from "./ThresholdLadder";

/** Six-month growth view for a single table (§5 of the brief). */
export function TableGrowthCard({ table, thresholds, appName }: { table: TableHealth; thresholds: RecordThresholds; appName?: string }) {
  const next = table.nextThreshold;
  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono">{table.tableName}</span>
          <SeverityBadge severity={table.severity} noneLabel="Below LOW" />
        </span>
      }
      description={appName ? `${appName} · last checked ${formatRelative(table.lastCheckedAt)}` : `Last checked ${formatRelative(table.lastCheckedAt)}`}
    >
      <KeyValueList
        columns={4}
        items={[
          { label: table.rowCountKind === "estimate" ? "Current records (estimate)" : "Current records", value: <span className="text-base font-semibold">{formatInt(table.rowCount)}</span> },
          { label: "6-month avg growth", value: <span className="text-base font-semibold">{table.avgDailyGrowth6m === null ? "Insufficient history" : `${formatInt(table.avgDailyGrowth6m)}/day`}</span> },
          {
            label: next ? `${next.level} threshold (${formatLakh(next.threshold)})` : "Threshold",
            value: <span className="text-base font-semibold">{next ? formatInt(next.threshold) : "Above HIGH"}</span>,
          },
          { label: "Records remaining", value: <span className="text-base font-semibold">{formatInt(table.recordsRemaining)}</span> },
        ]}
      />
      <ThresholdLadder rowCount={table.rowCount} thresholds={thresholds} className="mt-3 mb-4" />
      <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">Average records added per day · last 6 months</div>
      {table.avgDailyGrowth6m === null ? (
        <div className="mt-2 rounded-md border border-dashed border-line-strong bg-surface-2 px-3 py-3 text-xs text-ink-2">
          <span className="font-semibold tracking-wide text-ink">INSUFFICIENT HISTORY</span>
          <span className="text-ink-3"> — {table.growthNote ?? "growth cannot be measured yet"}. No growth rate or projection is inferred from the current row count.</span>
        </div>
      ) : (
        <>
          <GrowthChart points={table.monthlyGrowth} average={table.avgDailyGrowth6m} tableName={table.tableName} />
          <div className="mt-2 flex items-start gap-2 rounded-md border border-line bg-surface-2 px-3 py-2 text-xs text-ink-2">
            <Info className="mt-0.5 size-3.5 shrink-0 text-ink-3" aria-hidden />
            <div>
              <span className="font-semibold text-ink">Estimated days to next threshold: {next ? formatDays(table.projectedDaysToNextThreshold) : "—"}</span>
              <span className="text-ink-3">
                {" "}
                — informational projection at the 6-month average rate. Actual growth varies; this is not a guarantee and does not
                affect archive eligibility.
              </span>
            </div>
          </div>
        </>
      )}
    </Card>
  );
}
