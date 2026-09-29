import { formatInt } from "@/lib/domain/format";
import { cn } from "@/lib/cn";

/** "Before final day + Final day = Archive" — the whole-day rule made explicit. */
export function FinalDayEquation({
  before,
  finalDay,
  total,
  target,
  className,
}: {
  before: number;
  finalDay: number;
  total: number;
  target: number;
  className?: string;
}) {
  const cells = [
    { label: "Running total before final day", value: before, note: `${formatInt(target - before)} short of target` },
    { op: "+" },
    { label: "Final day (complete)", value: finalDay, note: "Included whole — never split" },
    { op: "=" },
    { label: "Archive", value: total, note: `${formatInt(total - target)} over target ${formatInt(target)}`, strong: true },
  ] as const;
  return (
    <div className={cn("rounded-md border border-line bg-surface-2 p-3", className)}>
      <div className="flex flex-wrap items-stretch gap-2">
        {cells.map((c, i) =>
          "op" in c ? (
            <div key={i} aria-hidden className="grid place-items-center px-1 text-lg font-semibold text-ink-3">
              {c.op}
            </div>
          ) : (
            <div
              key={i}
              className={cn(
                "min-w-36 flex-1 rounded-md border px-3 py-2",
                "strong" in c && c.strong ? "border-accent bg-accent-soft" : "border-line bg-surface",
              )}
            >
              <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">{c.label}</div>
              <div className="num mt-0.5 text-xl font-semibold tracking-tight">{formatInt(c.value)}</div>
              <div className="text-[11px] text-ink-3">{c.note}</div>
            </div>
          ),
        )}
      </div>
      <p className="mt-2 text-xs text-ink-2">
        <strong>Rule:</strong> dates are processed oldest first; each day is added in full across every selected table; selection
        stops on the first complete day that reaches or crosses the target. <strong>The final day is never split.</strong>
      </p>
    </div>
  );
}
