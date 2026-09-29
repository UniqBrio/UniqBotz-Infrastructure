import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { TONE_DOT, type Tone } from "@/components/ui/Badge";

/** Compact KPI tile. Tone only colours the indicator bar — the label carries meaning. */
export function MetricCard({
  label,
  value,
  hint,
  tone,
  icon,
  href,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
  icon?: ReactNode;
  href?: string;
}) {
  const body = (
    <div className="relative h-full overflow-hidden rounded-lg border border-line bg-surface px-4 py-3 transition-colors group-hover:border-line-strong">
      {tone && <span aria-hidden className={cn("absolute inset-y-0 left-0 w-1", TONE_DOT[tone])} />}
      <div className="flex items-center justify-between gap-2 text-[11px] font-semibold uppercase tracking-wider text-ink-3">
        {label}
        {icon}
      </div>
      <div className="mt-1.5 text-2xl font-semibold tracking-tight text-ink">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-ink-3">{hint}</div>}
    </div>
  );
  return href ? (
    <Link href={href} className="group block h-full">
      {body}
    </Link>
  ) : (
    body
  );
}
