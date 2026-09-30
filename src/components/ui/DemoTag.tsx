"use client";

import { cn } from "@/lib/cn";
import { useIsLive } from "@/lib/data/DataProvider";

/** Marks a mock/demo value. Hidden in live mode, where every value comes from the control plane. */
export function DemoTag({ className, label = "DEMO" }: { className?: string; label?: string }) {
  if (useIsLive()) return null;
  return (
    <span
      title="Mock/demo value — no live data source is connected in this phase."
      className={cn(
        "inline-flex shrink-0 items-center whitespace-nowrap rounded border border-dashed border-line-strong px-1 text-[9px] font-semibold tracking-wider text-ink-3",
        className,
      )}
    >
      {label}
    </span>
  );
}
