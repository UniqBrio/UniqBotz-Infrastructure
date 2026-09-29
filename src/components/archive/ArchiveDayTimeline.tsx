"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import { Fragment, useState } from "react";
import type { CandidateDay, WholeDaySelection } from "@/lib/domain/types";
import { dayTotal, runningTotals } from "@/lib/domain/selection";
import { formatDate, formatInt, formatShortDate } from "@/lib/domain/format";
import { cn } from "@/lib/cn";
import { Badge } from "@/components/ui/Badge";

/**
 * Day-wise aggregation table: Date | per-table counts | Day total | Running total.
 * Shows the last few selected days, the highlighted final day, the archive
 * boundary, and the first days after it that are NOT selected.
 */
export function ArchiveDayTimeline({
  days,
  tables,
  selection,
  target,
  tailDays = 3,
  afterDays = 2,
}: {
  days: CandidateDay[];
  tables: string[];
  selection: WholeDaySelection;
  target: number;
  tailDays?: number;
  afterDays?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const multi = tables.length > 1;
  const rows = runningTotals(selection.selectedDays);
  const finalIdx = rows.length - 1;
  const hiddenCount = Math.max(0, finalIdx - tailDays);
  const visible = expanded ? rows : rows.slice(hiddenCount);
  const hiddenRows = rows.slice(0, hiddenCount);
  const hiddenSum = hiddenRows.reduce((a, r) => a + r.total, 0);

  const ordered = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const after = selection.reachedTarget && selection.boundaryDate ? ordered.filter((d) => d.date > selection.boundaryDate!).slice(0, afterDays) : [];
  const colCount = 1 + (multi ? tables.length : 0) + 2;

  return (
    <div className="relative overflow-x-auto rounded-md border border-line">
      <table className="w-full border-collapse text-[13px]">
        <caption className="sr-only">Day-wise archive selection with running total</caption>
        <thead className="bg-surface-2">
          <tr className="border-b border-line text-left text-[11px] font-semibold uppercase tracking-wider text-ink-3">
            <th scope="col" className="px-3 py-2">Date</th>
            {multi &&
              tables.map((t) => (
                <th key={t} scope="col" className="px-3 py-2 text-right font-mono normal-case tracking-normal">
                  {t}
                </th>
              ))}
            <th scope="col" className="px-3 py-2 text-right">{multi ? "Day total" : "Records"}</th>
            <th scope="col" className="px-3 py-2 text-right">Running total</th>
          </tr>
        </thead>
        <tbody className="num">
          {hiddenCount > 0 && (
            <tr className="border-b border-line bg-surface">
              <td colSpan={colCount} className="px-3 py-1.5">
                <button
                  type="button"
                  onClick={() => setExpanded((e) => !e)}
                  aria-expanded={expanded}
                  className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
                >
                  {expanded ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
                  {expanded ? "Collapse" : "Show"} {formatInt(hiddenCount)} earlier selected days
                  {hiddenRows[0] && ` (${formatDate(hiddenRows[0].day.date)} → ${formatDate(hiddenRows[hiddenRows.length - 1]!.day.date)})`}
                  <span className="text-ink-3"> · subtotal {formatInt(hiddenSum)}</span>
                </button>
              </td>
            </tr>
          )}
          {visible.map((r) => {
            const isFinal = selection.reachedTarget && r.day.date === selection.boundaryDate;
            return (
              <Fragment key={r.day.date}>
                <tr className={cn("border-b border-line", isFinal ? "bg-accent-soft font-semibold" : "bg-surface")}>
                  <td className="px-3 py-1.5 whitespace-nowrap">
                    {formatShortDate(r.day.date)} <span className="text-ink-3">{r.day.date.slice(0, 4)}</span>
                    {isFinal && (
                      <Badge tone="info" size="xs" className="ml-2">
                        FINAL DAY · WHOLE
                      </Badge>
                    )}
                  </td>
                  {multi && tables.map((t) => <td key={t} className="px-3 py-1.5 text-right">{formatInt(r.day.countsByTable[t] ?? 0)}</td>)}
                  <td className="px-3 py-1.5 text-right">{formatInt(r.total)}</td>
                  <td className={cn("px-3 py-1.5 text-right", r.cumulative >= target && "text-accent-strong")}>
                    {formatInt(r.cumulative)}
                    {isFinal && selection.reachedTarget && <span className="ml-1 text-[11px] font-normal text-ink-3">≥ {formatInt(target)}</span>}
                  </td>
                </tr>
                {isFinal && (
                  <tr aria-label="Archive boundary">
                    <td colSpan={colCount} className="border-y-2 border-dashed border-accent bg-surface px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-accent-strong">
                      Archive boundary · {formatDate(r.day.date)} · selection stops here
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
          {after.map((d) => (
            <tr key={d.date} className="border-b border-line bg-surface text-ink-3">
              <td className="px-3 py-1.5 whitespace-nowrap">
                {formatShortDate(d.date)} <span>{d.date.slice(0, 4)}</span>
                <span className="ml-2 text-[10px] font-semibold tracking-wider">NOT SELECTED</span>
              </td>
              {multi && tables.map((t) => <td key={t} className="px-3 py-1.5 text-right">{formatInt(d.countsByTable[t] ?? 0)}</td>)}
              <td className="px-3 py-1.5 text-right">{formatInt(dayTotal(d))}</td>
              <td className="px-3 py-1.5 text-right">—</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
