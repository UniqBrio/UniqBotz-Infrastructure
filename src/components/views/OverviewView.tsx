"use client";

import Link from "next/link";
import { AlertOctagon, ArrowRight, Clock, HelpCircle } from "lucide-react";
import type { ApplicationHealth, ArchiveJob, InfrastructureSettings, TableHealth } from "@/lib/domain/types";
import {
  combineResources,
  useAlerts,
  useApplicationHealthList,
  useArchiveJobs,
  useSettings,
  useTables,
} from "@/lib/data/hooks";
import { useScopedAppId } from "@/lib/data/scope";
import { isActiveJob } from "@/lib/domain/jobs";
import { SEVERITY_RANK } from "@/lib/domain/severity";
import { formatDays, formatInt, formatLakh, formatPct, formatRelative } from "@/lib/domain/format";
import { Card } from "@/components/ui/Card";
import { DataState } from "@/components/ui/DataState";
import { PageHeader } from "@/components/ui/PageHeader";
import { CardGridSkeleton, EmptyState } from "@/components/ui/States";
import { Table, TD, TH, THead, TR } from "@/components/ui/Table";
import { ApplicationCard } from "@/components/monitoring/ApplicationCard";
import { MetricCard } from "@/components/monitoring/MetricCard";
import { TableGrowthCard } from "@/components/monitoring/TableGrowthCard";
import { SeverityBadge } from "@/components/status/SeverityBadge";
import { JobStatusBadge } from "@/components/status/JobStatusBadge";
import { ScopeEyebrow } from "./ScopeEyebrow";

export function OverviewView() {
  const appId = useScopedAppId();
  const health = useApplicationHealthList();
  const all = combineResources({
    health,
    tables: useTables(appId),
    jobs: useArchiveJobs(appId),
    alerts: useAlerts(appId),
    settings: useSettings(),
  });

  return (
    <>
      <PageHeader
        eyebrow={<ScopeEyebrow />}
        title="Overview"
        description="Operational status of every monitored UniqBotz application: database capacity, table thresholds, growth and archive activity."
      />
      <DataState resource={all} loading={<CardGridSkeleton count={6} />}>
        {({ health, tables, jobs, alerts, settings }) => {
          const apps = appId ? health.filter((h) => h.application.id === appId) : health;
          const needs = apps.filter((h) => h.status !== "healthy");
          const activeJobs = jobs.filter(isActiveJob);
          const failed = jobs.filter((j) => j.status === "failed");
          const latestCheck = apps.map((h) => h.application.lastHealthCheckAt).sort().at(-1);
          const activeAlerts = alerts.filter((a) => a.state === "active");
          return (
            <div className="space-y-6">
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
                <MetricCard label="Applications" value={apps.length} hint="Monitored" href="/applications" />
                <MetricCard label="Healthy" value={apps.length - needs.length} tone="ok" hint="Below all thresholds" />
                <MetricCard label="Needs attention" value={needs.length} tone={needs.length ? "med" : "ok"} hint={needs.map((h) => h.application.name).join(", ") || "None"} />
                <MetricCard label="Active archive jobs" value={activeJobs.length} tone="info" hint={`${activeJobs.filter((j) => j.status === "ready_for_deletion").length} awaiting deletion review`} href="/archive-jobs" />
                <MetricCard label="Failed jobs" value={failed.length} tone={failed.length ? "high" : "ok"} hint="0 records deleted on failure" href="/archive-history" />
                <MetricCard label="Last health check" value={<span className="text-lg">{formatRelative(latestCheck)}</span>} hint={`${activeAlerts.length} active alerts`} href="/alerts" />
              </div>

              <AttentionPanel apps={apps} tables={tables} jobs={jobs} />

              <section aria-labelledby="apps-heading">
                <h2 id="apps-heading" className="mb-2 text-[13px] font-semibold text-ink-2">
                  Application health
                </h2>
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {apps.map((h) => (
                    <ApplicationCard key={h.application.id} health={h} capacity={settings.capacityThresholdsPct} />
                  ))}
                </div>
              </section>

              <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
                <ThresholdTable tables={tables} settings={settings} appNames={Object.fromEntries(health.map((h) => [h.application.id, h.application.name]))} />
                <SeverityLegend tables={tables} settings={settings} />
              </div>

              <GrowthSection tables={tables} settings={settings} appNames={Object.fromEntries(health.map((h) => [h.application.id, h.application.name]))} />
            </div>
          );
        }}
      </DataState>
    </>
  );
}

function AttentionPanel({ apps, tables, jobs }: { apps: ApplicationHealth[]; tables: TableHealth[]; jobs: ArchiveJob[] }) {
  const name = (id: string) => apps.find((a) => a.application.id === id)?.application.name ?? id;
  const items: { key: string; rank: number; icon: React.ReactNode; text: React.ReactNode; href: string }[] = [];

  for (const t of tables.filter((t) => t.severity !== "NONE")) {
    items.push({
      key: `t-${t.applicationId}-${t.tableName}`,
      rank: SEVERITY_RANK[t.severity] * 10,
      icon: <SeverityBadge severity={t.severity} size="xs" />,
      text: (
        <>
          <strong>{name(t.applicationId)}</strong> · <span className="font-mono">{t.tableName}</span> at {formatInt(t.rowCount)} records
        </>
      ),
      href: `/applications/${t.applicationId}`,
    });
  }
  for (const h of apps.filter((h) => h.dbSeverity !== "NONE")) {
    items.push({
      key: `db-${h.application.id}`,
      rank: SEVERITY_RANK[h.dbSeverity] * 10 - 1,
      icon: <SeverityBadge severity={h.dbSeverity} size="xs" />,
      text: (
        <>
          <strong>{h.application.name}</strong> database at {formatPct(h.dbUsagePct)} of capacity
        </>
      ),
      href: "/database-health",
    });
  }
  for (const j of jobs.filter((j) => j.status === "failed" || j.status === "requires_review" || j.status === "ready_for_deletion")) {
    items.push({
      key: `j-${j.id}`,
      rank: j.status === "failed" ? 25 : 15,
      icon: <JobStatusBadge status={j.status} size="xs" />,
      text: (
        <>
          <span className="font-mono">{j.id}</span> · {name(j.applicationId)} · <span className="font-mono">{j.tables.join(" + ")}</span>
        </>
      ),
      href: `/archive-jobs/${j.id}`,
    });
  }
  const review = tables.filter((t) => t.policy === "review_required");
  if (review.length > 0) {
    items.push({
      key: "review",
      rank: 5,
      icon: <HelpCircle className="size-4 text-low-ink" aria-hidden />,
      text: (
        <>
          {review.length} tables awaiting a retention decision ({review.filter((t) => t.isNewlyDiscovered).length} newly discovered)
        </>
      ),
      href: "/retention",
    });
  }
  items.sort((a, b) => b.rank - a.rank);

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <AlertOctagon className="size-4 text-ink-3" aria-hidden /> Needs attention
        </span>
      }
      description="Ordered by severity. Thresholds and capacity alerts inform the operator — they never trigger archival on their own."
      flush
    >
      {items.length === 0 ? (
        <EmptyState title="Nothing needs attention" description="All applications are below every threshold." />
      ) : (
        <ul className="divide-y divide-line">
          {items.map((it) => (
            <li key={it.key}>
              <Link href={it.href} className="flex items-center gap-3 px-4 py-2 text-[13px] hover:bg-surface-2">
                <span className="w-32 shrink-0">{it.icon}</span>
                <span className="min-w-0 flex-1 truncate">{it.text}</span>
                <ArrowRight className="size-3.5 shrink-0 text-ink-3" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ThresholdTable({ tables, settings, appNames }: { tables: TableHealth[]; settings: InfrastructureSettings; appNames: Record<string, string> }) {
  const low = settings.recordThresholds.low;
  const rows = tables.filter((t) => t.rowCount >= low * 0.5).sort((a, b) => b.rowCount - a.rowCount);
  return (
    <Card
      title="Tables approaching thresholds"
      description={`Tables at or above 50% of the LOW threshold (${formatInt(low * 0.5)} records). Projections are estimates at the 6-month average rate.`}
      flush
    >
      {rows.length === 0 ? (
        <EmptyState title="No large tables" description="No table is above 50% of the LOW threshold." />
      ) : (
        <Table caption="Tables approaching record thresholds">
          <THead>
            <tr>
              <TH>Table</TH>
              <TH align="right">Current records</TH>
              <TH align="right">Next threshold</TH>
              <TH align="right">Records remaining</TH>
              <TH align="right">Avg/day</TH>
              <TH align="right">Est. days</TH>
              <TH>Severity</TH>
              <TH>Last checked</TH>
            </tr>
          </THead>
          <tbody>
            {rows.map((t) => (
              <TR key={`${t.applicationId}.${t.tableName}`}>
                <TD>
                  <Link href={`/applications/${t.applicationId}`} className="hover:underline">
                    <span className="font-mono text-[12.5px] font-medium">{t.tableName}</span>
                    <span className="block text-[11px] text-ink-3">{appNames[t.applicationId]}</span>
                  </Link>
                </TD>
                <TD align="right" className="font-medium">
                  {formatInt(t.rowCount)}
                </TD>
                <TD align="right">
                  {t.nextThreshold ? (
                    <>
                      {formatInt(t.nextThreshold.threshold)} <span className="text-[11px] text-ink-3">{t.nextThreshold.level}</span>
                    </>
                  ) : (
                    <span className="text-ink-3">Above HIGH</span>
                  )}
                </TD>
                <TD align="right">{formatInt(t.recordsRemaining)}</TD>
                <TD align="right">{formatInt(t.avgDailyGrowth6m)}</TD>
                <TD align="right" className="text-ink-2" title="Informational projection — not a guarantee">
                  {t.nextThreshold ? formatDays(t.projectedDaysToNextThreshold) : "—"}
                </TD>
                <TD>
                  <SeverityBadge severity={t.severity} noneLabel="Below LOW" />
                </TD>
                <TD className="whitespace-nowrap text-xs text-ink-3">
                  <Clock className="mr-1 inline size-3" aria-hidden />
                  {formatRelative(t.lastCheckedAt)}
                </TD>
              </TR>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function SeverityLegend({ tables, settings }: { tables: TableHealth[]; settings: InfrastructureSettings }) {
  const t = settings.recordThresholds;
  const levels = [
    { level: "LOW" as const, value: t.low },
    { level: "MEDIUM" as const, value: t.medium },
    { level: "HIGH" as const, value: t.high },
  ];
  return (
    <Card title="Record thresholds" description="Configured per table · editable in Settings">
      <ul className="space-y-2.5">
        {levels.map((l) => (
          <li key={l.level} className="flex items-center gap-3">
            <span className="w-20">
              <SeverityBadge severity={l.level} />
            </span>
            <span className="flex-1">
              <span className="num block text-[13px] font-semibold">{formatInt(l.value)}</span>
              <span className="block text-[11px] text-ink-3">
                {formatLakh(l.value)} records
              </span>
            </span>
            <span className="num text-right text-xs text-ink-2">
              <span className="block text-base font-semibold text-ink">{tables.filter((x) => x.severity === l.level).length}</span>
              tables
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-3 border-t border-line pt-2 text-[11px] text-ink-3">
        A table reaching a threshold raises an alert only — it never archives data by itself. Alerts go to WhatsApp{" "}
        <span className="num font-medium text-ink-2">{settings.notifications.whatsappNumber}</span>.
      </p>
    </Card>
  );
}

function GrowthSection({ tables, settings, appNames }: { tables: TableHealth[]; settings: InfrastructureSettings; appNames: Record<string, string> }) {
  const relevant = [...tables]
    .filter((t) => t.severity !== "NONE" || t.rowCount >= settings.recordThresholds.low * 0.6)
    .sort((a, b) => (a.recordsRemaining ?? -1) - (b.recordsRemaining ?? -1))
    .slice(0, 4);
  if (relevant.length === 0) return null;
  return (
    <section aria-labelledby="growth-heading">
      <h2 id="growth-heading" className="mb-2 text-[13px] font-semibold text-ink-2">
        Six-month growth · tables closest to their next threshold
      </h2>
      <div className="grid gap-4 xl:grid-cols-2">
        {relevant.map((t) => (
          <TableGrowthCard key={`${t.applicationId}.${t.tableName}`} table={t} thresholds={settings.recordThresholds} appName={appNames[t.applicationId]} />
        ))}
      </div>
    </section>
  );
}
