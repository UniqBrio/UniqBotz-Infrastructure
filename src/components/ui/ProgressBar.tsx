import { cn } from "@/lib/cn";
import { TONE_DOT, type Tone } from "./Badge";

export function ProgressBar({
  value,
  tone = "info",
  label,
  className,
  markers,
}: {
  /** 0–100 */
  value: number;
  tone?: Tone;
  label: string;
  className?: string;
  /** Optional threshold ticks, as percentages of the bar. */
  markers?: { at: number; label: string }[];
}) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className={cn("relative", className)}>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuenow={Math.round(v)}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-2 w-full overflow-hidden rounded-full bg-neutral-soft"
      >
        <div className={cn("h-full rounded-full", TONE_DOT[tone])} style={{ width: `${v}%` }} />
      </div>
      {markers?.map((m) => (
        <span
          key={m.label}
          title={m.label}
          aria-hidden
          className="absolute -top-0.5 h-3 w-px bg-ink-2"
          style={{ left: `${Math.min(100, m.at)}%` }}
        />
      ))}
    </div>
  );
}
