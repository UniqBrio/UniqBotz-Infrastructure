import { AlertOctagon, Inbox, RotateCw } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Button } from "./Button";

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("animate-pulse rounded bg-neutral-soft", className)} />;
}

export function LoadingState({ rows = 4, label = "Loading…", className }: { rows?: number; label?: string; className?: string }) {
  return (
    <div role="status" aria-live="polite" className={cn("space-y-2.5", className)}>
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={cn("h-4", i % 3 === 0 ? "w-3/4" : i % 3 === 1 ? "w-full" : "w-5/6")} />
      ))}
    </div>
  );
}

export function CardGridSkeleton({ count = 3, className }: { count?: number; className?: string }) {
  return (
    <div role="status" className={cn("grid gap-4 md:grid-cols-2 xl:grid-cols-3", className)}>
      <span className="sr-only">Loading…</span>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="space-y-3 rounded-lg border border-line bg-surface p-4">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-7 w-1/2" />
          <Skeleton className="h-2 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
  className,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-10 text-center", className)}>
      <div className="mb-2 text-ink-3">{icon ?? <Inbox className="size-6" aria-hidden />}</div>
      <p className="text-[13px] font-semibold text-ink">{title}</p>
      {description && <p className="mt-1 max-w-md text-xs text-ink-3">{description}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry, className }: { error: Error | undefined; onRetry?: () => void; className?: string }) {
  return (
    <div role="alert" className={cn("flex flex-col items-center justify-center px-6 py-10 text-center", className)}>
      <AlertOctagon className="mb-2 size-6 text-high" aria-hidden />
      <p className="text-[13px] font-semibold text-ink">Could not load data</p>
      <p className="mt-1 max-w-md text-xs text-ink-3">{error?.message ?? "Unknown error."}</p>
      {onRetry && (
        <Button size="sm" className="mt-3" onClick={onRetry}>
          <RotateCw className="size-3.5" aria-hidden /> Retry
        </Button>
      )}
    </div>
  );
}
