import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function KeyValueList({ items, className, columns = 2 }: { items: { label: ReactNode; value: ReactNode }[]; className?: string; columns?: 1 | 2 | 3 | 4 }) {
  return (
    <dl
      className={cn(
        "grid gap-x-6 gap-y-3",
        columns === 2 && "sm:grid-cols-2",
        columns === 3 && "sm:grid-cols-2 lg:grid-cols-3",
        columns === 4 && "sm:grid-cols-2 lg:grid-cols-4",
        className,
      )}
    >
      {items.map((it, i) => (
        <div key={i} className="min-w-0">
          <dt className="text-[11px] font-medium uppercase tracking-wider text-ink-3">{it.label}</dt>
          <dd className="num mt-0.5 text-[13px] text-ink">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}
