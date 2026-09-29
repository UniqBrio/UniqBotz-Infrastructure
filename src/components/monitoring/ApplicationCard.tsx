import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type { ApplicationHealth, CapacityThresholdsPct } from "@/lib/domain/types";
import { formatInt, formatRelative } from "@/lib/domain/format";
import { HealthStatusBadge } from "@/components/status/HealthStatusBadge";
import { SeverityBadge } from "@/components/status/SeverityBadge";
import { ConnectionBadge } from "@/components/status/ConnectionBadge";
import { DatabaseUsageCard } from "./DatabaseUsageCard";

/** Application-level health summary used on Overview and Applications. */
export function ApplicationCard({ health, capacity }: { health: ApplicationHealth; capacity: CapacityThresholdsPct }) {
  const a = health.application;
  const lt = health.largestTable;
  return (
    <article className="flex h-full flex-col rounded-lg border border-line bg-surface">
      <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold tracking-tight">
            <Link href={`/applications/${a.id}`} className="hover:underline">
              {a.name}
            </Link>
          </h3>
          <p className="truncate text-xs text-ink-3">{a.description}</p>
        </div>
        <HealthStatusBadge status={health.status} />
      </header>
      <div className="flex-1 space-y-4 px-4 py-3">
        <DatabaseUsageCard health={health} capacity={capacity} showThresholdNote={false} />
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-[13px]">
          <div>
            <dt className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">Status</dt>
            <dd className="mt-0.5">
              <SeverityBadge severity={health.overallSeverity} />
            </dd>
          </div>
          <div>
            <dt className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">Growth</dt>
            <dd className="num mt-0.5 font-medium">{formatInt(health.totalAvgDailyGrowth)} records/day</dd>
          </div>
          <div className="col-span-2">
            <dt className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">Largest table</dt>
            <dd className="mt-0.5 flex flex-wrap items-center gap-2">
              {lt ? (
                <>
                  <span className="font-mono text-[12.5px] font-medium">{lt.tableName}</span>
                  <span className="num text-ink-2">{formatInt(lt.rowCount)} records</span>
                  <SeverityBadge severity={lt.severity} size="xs" noneLabel="Below LOW" />
                </>
              ) : (
                <span className="text-ink-3">No tables discovered</span>
              )}
            </dd>
          </div>
        </dl>
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2 text-xs text-ink-3">
        <span className="inline-flex items-center gap-2">
          <ConnectionBadge status={a.connectionStatus} />
        </span>
        <span>
          {health.tableCount} tables · checked {formatRelative(a.lastHealthCheckAt)}
        </span>
        <Link href={`/applications/${a.id}`} className="inline-flex items-center gap-0.5 font-medium text-accent hover:underline">
          Details <ArrowUpRight className="size-3" aria-hidden />
        </Link>
      </footer>
    </article>
  );
}
