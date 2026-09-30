import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export type Tone = "neutral" | "ok" | "low" | "med" | "high" | "info";

export const TONE_CLASSES: Record<Tone, string> = {
  neutral: "bg-neutral-soft text-ink-2 border-neutral-line",
  ok: "bg-ok-soft text-ok-ink border-ok-line",
  low: "bg-low-soft text-low-ink border-low-line",
  med: "bg-med-soft text-med-ink border-med-line",
  high: "bg-high-soft text-high-ink border-high-line",
  info: "bg-info-soft text-info-ink border-info-line",
};

export const TONE_DOT: Record<Tone, string> = {
  neutral: "bg-ink-3",
  ok: "bg-ok",
  low: "bg-low",
  med: "bg-med",
  high: "bg-high",
  info: "bg-info",
};

export function Badge({
  tone = "neutral",
  icon,
  children,
  className,
  size = "sm",
  title,
}: {
  tone?: Tone;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
  size?: "xs" | "sm" | "md";
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded border font-semibold",
        size === "xs" && "px-1.5 py-px text-[10px] tracking-wide",
        size === "sm" && "px-1.5 py-0.5 text-[11px] tracking-wide",
        size === "md" && "px-2 py-1 text-xs tracking-wide",
        TONE_CLASSES[tone],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}

/** Small marker for values that come from mock/demo data. */
export { DemoTag } from "./DemoTag";
