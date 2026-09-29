import { AlertOctagon, CheckCircle2, Circle, Eye, Loader2, Lock } from "lucide-react";
import type { PipelineStep, PipelineStepStatus } from "@/lib/domain/types";
import { PIPELINE_STEP_LABEL } from "@/lib/domain/labels";
import { formatDateTime, formatInt } from "@/lib/domain/format";
import { cn } from "@/lib/cn";

const STATUS: Record<PipelineStepStatus, { label: string; Icon: typeof Circle; ring: string; text: string }> = {
  passed: { label: "Passed", Icon: CheckCircle2, ring: "border-ok-line bg-ok-soft text-ok-ink", text: "text-ok-ink" },
  running: { label: "In progress", Icon: Loader2, ring: "border-info-line bg-info-soft text-info-ink", text: "text-info-ink" },
  failed: { label: "Failed", Icon: AlertOctagon, ring: "border-high-line bg-high-soft text-high-ink", text: "text-high-ink" },
  blocked: { label: "Blocked", Icon: Lock, ring: "border-neutral-line bg-neutral-soft text-ink-3", text: "text-ink-3" },
  awaiting_review: { label: "Awaiting review", Icon: Eye, ring: "border-low-line bg-low-soft text-low-ink", text: "text-low-ink" },
  pending: { label: "Pending", Icon: Circle, ring: "border-line bg-surface text-ink-3", text: "text-ink-3" },
};

/** Vertical lifecycle: Candidate Selection → … → Completed, with per-step evidence. */
export function ArchiveJobPipeline({ steps }: { steps: PipelineStep[] }) {
  return (
    <ol className="relative">
      {steps.map((s, i) => {
        const st = STATUS[s.status];
        const last = i === steps.length - 1;
        return (
          <li key={s.key} className="relative flex gap-3 pb-5 last:pb-0">
            {!last && <span aria-hidden className={cn("absolute top-8 bottom-0 left-[15px] w-0.5", s.status === "passed" ? "bg-ok-line" : "bg-line")} />}
            <div className={cn("relative z-10 grid size-8 shrink-0 place-items-center rounded-full border", st.ring)}>
              <st.Icon className={cn("size-4", s.status === "running" && "animate-spin [animation-duration:2.5s]")} aria-hidden />
            </div>
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <span className="text-[13px] font-semibold">{PIPELINE_STEP_LABEL[s.key]}</span>
                <span className={cn("text-[11px] font-semibold uppercase tracking-wider", st.text)}>{st.label}</span>
                {s.at && <span className="text-xs text-ink-3">{formatDateTime(s.at)}</span>}
                {s.recordCount !== null && <span className="num text-xs text-ink-2">{formatInt(s.recordCount)} records</span>}
              </div>
              {s.detail && <p className="mt-0.5 text-xs text-ink-2">{s.detail}</p>}
              {s.error && (
                <p role="alert" className="mt-1 rounded border border-high-line bg-high-soft px-2 py-1 text-xs font-medium text-high-ink">
                  {s.error}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Compact horizontal step indicator for tables and cards. */
export function PipelineMini({ steps }: { steps: PipelineStep[] }) {
  return (
    <div className="flex items-center gap-0.5" aria-label="Pipeline progress">
      {steps.map((s) => (
        <span
          key={s.key}
          title={`${PIPELINE_STEP_LABEL[s.key]}: ${STATUS[s.status].label}`}
          className={cn(
            "h-1.5 w-4 rounded-sm",
            s.status === "passed" && "bg-ok",
            s.status === "running" && "bg-info",
            s.status === "failed" && "bg-high",
            s.status === "awaiting_review" && "bg-low",
            (s.status === "pending" || s.status === "blocked") && "bg-neutral-line",
          )}
        />
      ))}
    </div>
  );
}
