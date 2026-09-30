"use client";

import Link from "next/link";
import { AlertTriangle, Eye, Lock } from "lucide-react";
import { useMemo, useState } from "react";
import type { ArchiveCandidate } from "@/lib/domain/types";
import { selectWholeDays } from "@/lib/domain/selection";
import { formatDate, formatInt } from "@/lib/domain/format";
import { cn } from "@/lib/cn";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { KeyValueList } from "@/components/ui/KeyValue";
import { ArchiveDayTimeline } from "./ArchiveDayTimeline";
import { FinalDayEquation } from "./FinalDayEquation";

/**
 * Preview of what WOULD be archived for one candidate (single- or multi-table).
 * Everything is computed from mock daily counts; nothing is frozen or exported.
 */
export function ArchiveCandidateCard({ candidate, appName }: { candidate: ArchiveCandidate; appName: string }) {
  const [selectedTables, setSelectedTables] = useState<string[]>(candidate.tables);
  const multi = candidate.tables.length > 1;

  const days = useMemo(
    () =>
      candidate.days.map((d) => ({
        date: d.date,
        countsByTable: Object.fromEntries(selectedTables.map((t) => [t, d.countsByTable[t] ?? 0])),
      })),
    [candidate.days, selectedTables],
  );
  const selection = useMemo(() => selectWholeDays(days, candidate.target), [days, candidate.target]);
  const toggle = (t: string) =>
    setSelectedTables((cur) => (cur.includes(t) ? (cur.length > 1 ? cur.filter((x) => x !== t) : cur) : candidate.tables.filter((x) => cur.includes(x) || x === t)));

  const blocked = (candidate.blocking?.length ?? 0) > 0;
  const reason = selection.reachedTarget
    ? `Target crossed on final complete day (${formatDate(selection.boundaryDate)})`
    : "Eligible records do not reach the target";

  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          {appName}
          <span className="text-ink-3">·</span>
          <span className="font-mono">{candidate.tables.length > 1 ? `${candidate.tables.length} tables` : candidate.tables[0]}</span>
          <Badge tone="info" size="xs" icon={<Eye className="size-3" aria-hidden />}>
            PREVIEW ONLY
          </Badge>
          {multi && <Badge tone="neutral" size="xs">MULTI-TABLE</Badge>}
        </span>
      }
      description={`Archive candidate ${candidate.id}`}
      actions={
        <Button variant="secondary" size="sm" disabled title={candidate.readOnly ? "Phase 3B: jobs are created by an operator with the worker CLI (archive-and-verify only)" : "Job creation is implemented in the backend phase"}>
          <Lock className="size-3.5" aria-hidden /> {candidate.readOnly ? "Create job (operator CLI only)" : "Create archive job (backend phase)"}
        </Button>
      }
    >
      <div className="space-y-4">
        {candidate.readOnly && (
          <p className="text-[11px] font-semibold tracking-wide text-ink-3">
            READ ONLY · computed by the worker in a read-only snapshot at {formatDate(candidate.generatedAt)} · no job created, nothing frozen
          </p>
        )}
        {candidate.blocking && candidate.blocking.length > 0 && (
          <div className="rounded-md border border-high-line bg-high-soft px-3 py-2 text-xs text-high-ink">
            <strong>Not archivable as configured:</strong>
            <ul className="mt-1 list-disc pl-4">{candidate.blocking.map((b) => <li key={b}>{b}</li>)}</ul>
          </div>
        )}
        {candidate.excluded && candidate.excluded.length > 0 && (
          <div className="rounded-md border border-line bg-surface-2 px-3 py-2 text-xs text-ink-2">
            <strong className="text-ink">Records excluded from this candidate</strong>
            <ul className="mt-1 space-y-0.5">
              {candidate.excluded.map((x) => (
                <li key={x.reason} className="flex flex-wrap gap-x-2">
                  <span className="num font-semibold text-ink">{formatInt(x.rows)}</span>
                  <span className="font-mono">{x.reason}</span>
                  <span className="text-ink-3">— {x.detail}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {candidate.blockedByJobId && (
          <div className="flex items-start gap-2 rounded-md border border-low-line bg-low-soft px-3 py-2 text-xs text-low-ink">
            <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <p>
              <strong>Waiting on an active job.</strong>{" "}
              <Link href={`/archive-jobs/${candidate.blockedByJobId}`} className="font-semibold underline">
                {candidate.blockedByJobId}
              </Link>{" "}
              is still active for this table.{" "}
              {candidate.previousBoundary ? `This preview continues from its boundary (${formatDate(candidate.previousBoundary)}) and` : "A new job"}{" "}
              cannot start until that job finishes.
            </p>
          </div>
        )}
        {blocked && (
          <p className="text-xs text-ink-2">
            No selection is computed while the configuration is blocked. Fix the reasons above (policy, FK group, RLS role) and collect again.
          </p>
        )}
        {!blocked && !selection.reachedTarget && (
          <div className="flex items-start gap-2 rounded-md border border-line bg-surface-2 px-3 py-2 text-xs text-ink-2">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-ink-3" aria-hidden />
            <p>
              <strong>Target not reached.</strong> All {formatInt(selection.selectedDays.length)} eligible days total{" "}
              {formatInt(selection.totalSelected)} records — below the {formatInt(candidate.target)} target. How the engine treats an
              under-target candidate is decided in the backend phase.
            </p>
          </div>
        )}

        {!blocked && multi && (
          <fieldset className="rounded-md border border-line p-3">
            <legend className="px-1 text-[11px] font-semibold uppercase tracking-wider text-ink-3">Selected tables</legend>
            <div className="flex flex-wrap gap-2">
              {candidate.tables.map((t) => {
                const on = selectedTables.includes(t);
                return (
                  <label
                    key={t}
                    className={cn(
                      "inline-flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-[13px]",
                      on ? "border-accent bg-accent-soft" : "border-line bg-surface text-ink-3",
                    )}
                  >
                    <input type="checkbox" checked={on} onChange={() => toggle(t)} className="accent-[var(--color-accent)]" />
                    <span className="font-mono">{t}</span>
                    <span className="num text-xs text-ink-3">{formatInt(selection.totalsByTable[t] ?? 0)}</span>
                  </label>
                );
              })}
            </div>
            <p className="mt-2 text-[11px] text-ink-3">
              Toggle tables to preview how the whole-day selection changes. Each day includes every selected table. Parent/child
              deletion order will be derived from the actual foreign-key graph in the backend phase.
            </p>
          </fieldset>
        )}

        {!blocked && (
        <KeyValueList
          columns={4}
          items={[
            { label: "Oldest eligible date", value: formatDate(selection.oldestDate) },
            {
              label: "Proposed archive boundary",
              value: selection.reachedTarget ? <strong>{formatDate(selection.boundaryDate)}</strong> : <span className="text-ink-3">None — target not reached</span>,
            },
            { label: "Target", value: formatInt(candidate.target) },
            { label: selection.reachedTarget ? "Selected" : "Eligible (not selected)", value: <strong>{formatInt(selection.totalSelected)}</strong> },
            { label: "Protected period", value: `${candidate.protectedPeriodMonths} months (on/after ${formatDate(candidate.protectedFrom)})` },
            {
              label: "Date column",
              value: (
                <span className="font-mono text-[12px]">
                  {Object.entries(candidate.dateColumnByTable)
                    .filter(([t]) => selectedTables.includes(t))
                    .map(([t, c]) => (multi ? `${t}.${c}` : c))
                    .join(", ")}
                </span>
              ),
            },
            { label: "Previous boundary", value: candidate.previousBoundary ? formatDate(candidate.previousBoundary) : "None (first run)" },
            { label: "Reason", value: reason },
          ]}
        />
        )}

        {selection.reachedTarget && (
          <FinalDayEquation
            before={selection.totalBeforeFinalDay}
            finalDay={selection.finalDayCount}
            total={selection.totalSelected}
            target={candidate.target}
          />
        )}

        {!blocked && (
          <div>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-3">Daily aggregation</div>
            <ArchiveDayTimeline days={days} tables={selectedTables} selection={selection} target={candidate.target} />
          </div>
        )}
      </div>
    </Card>
  );
}
