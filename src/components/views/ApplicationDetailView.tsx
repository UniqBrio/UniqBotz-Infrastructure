"use client";

import Link from "next/link";
import { ArrowLeft, Crosshair } from "lucide-react";
import { useState } from "react";
import type { TableHealth } from "@/lib/domain/types";
import {
  combineResources,
  useAlerts,
  useApplicationHealth,
  useApplicationNames,
  useArchiveJobs,
  useRetentionPolicies,
  useSettings,
  useTables,
} from "@/lib/data/hooks";
import { setAppScope, useAppScope } from "@/lib/data/scope";
import { POLICY_LABEL } from "@/lib/domain/labels";
import { formatDateTime, formatInt, formatRelative } from "@/lib/domain/format";
import { Button, LinkButton } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { DataState } from "@/components/ui/DataState";
import { Dialog } from "@/components/ui/Dialog";
import { KeyValueList } from "@/components/ui/KeyValue";
import { PageHeader } from "@/components/ui/PageHeader";
import { CardGridSkeleton, EmptyState } from "@/components/ui/States";
import { AlertTable } from "@/components/alerts/AlertTable";
import { ArchiveJobTable } from "@/components/archive/ArchiveJobTable";
import { DatabaseUsageCard } from "@/components/monitoring/DatabaseUsageCard";
import { TableGrowthCard } from "@/components/monitoring/TableGrowthCard";
import { TableHealthTable } from "@/components/monitoring/TableHealthTable";
import { ConnectionBadge } from "@/components/status/ConnectionBadge";
import { HealthStatusBadge } from "@/components/status/HealthStatusBadge";
import { SeverityBadge } from "@/components/status/SeverityBadge";
import { DemoTag } from "@/components/ui/Badge";

export function ApplicationDetailView({ appId, initialTable }: { appId: string; initialTable?: string }) {
  const scope = useAppScope();
  const names = useApplicationNames();
  const [viewing, setViewing] = useState<string | null>(initialTable ?? null);
  const all = combineResources({
    health: useApplicationHealth(appId),
    tables: useTables(appId),
    policies: useRetentionPolicies(appId),
    jobs: useArchiveJobs(appId),
    alerts: useAlerts(appId),
    settings: useSettings(),
  });

  return (
    <DataState resource={all} loading={<CardGridSkeleton count={3} />}>
      {({ health, tables, policies, jobs, alerts, settings }) => {
        if (!health) {
          return (
            <Card>
              <EmptyState
                title="Application not found"
                description={`No application with id “${appId}” is registered.`}
                action={<LinkButton href="/applications">Back to applications</LinkButton>}
              />
            </Card>
          );
        }
        const a = health.application;
        const viewed = tables.find((t) => t.tableName === viewing) ?? null;
        const growthTables = tables.filter((t) => t.rowCount >= 100_000).slice(0, 4);
        return (
          <>
            <PageHeader
              eyebrow={
                <Link href="/applications" className="inline-flex items-center gap-1 hover:text-ink">
                  <ArrowLeft className="size-3" aria-hidden /> Applications
                </Link>
              }
              title={
                <span className="flex flex-wrap items-center gap-2">
                  {a.name} <HealthStatusBadge status={health.status} size="md" />
                </span>
              }
              description={a.description}
              actions={
                <Button onClick={() => setAppScope(a.id)} disabled={scope === a.id}>
                  <Crosshair className="size-3.5" aria-hidden /> {scope === a.id ? "Current scope" : "Scope dashboard to this app"}
                </Button>
              }
            />
            <div className="space-y-6">
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
                <Card title="Database health">
                  <DatabaseUsageCard health={health} capacity={settings.capacityThresholdsPct} />
                  <div className="mt-4 grid grid-cols-3 gap-3 border-t border-line pt-3">
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">Status</div>
                      <div className="mt-1">
                        <SeverityBadge severity={health.overallSeverity} size="md" />
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">Table severity</div>
                      <div className="mt-1">
                        <SeverityBadge severity={health.tableSeverity} />
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">Capacity severity</div>
                      <div className="mt-1">
                        <SeverityBadge severity={health.dbSeverity} />
                      </div>
                    </div>
                  </div>
                </Card>
                <Card title="Connection & registry" description="Values are simulated — no Supabase project is connected.">
                  <KeyValueList
                    items={[
                      { label: "Supabase project", value: <span className="inline-flex items-center gap-1.5 font-mono text-[12px]">{a.supabaseProjectRef} <DemoTag /></span> },
                      { label: "Connection", value: <ConnectionBadge status={a.connectionStatus} /> },
                      { label: "Region", value: a.region },
                      { label: "Last health check", value: `${formatRelative(a.lastHealthCheckAt)} · ${formatDateTime(a.lastHealthCheckAt)}` },
                      { label: "Tables discovered", value: health.tableCount },
                      { label: "Record growth", value: `${formatInt(health.totalAvgDailyGrowth)} records/day (6-mo avg)` },
                      { label: "Awaiting retention decision", value: `${health.tablesNeedingReview} tables` },
                      { label: "Registered", value: formatDateTime(a.registeredAt) },
                    ]}
                  />
                </Card>
              </div>

              <Card
                title="Table overview"
                description="Discovered tables, largest first. Severity uses the configured 10L / 11L / 12L record thresholds."
                actions={<LinkButton href="/retention" size="sm">Configure retention</LinkButton>}
                flush
              >
                <TableHealthTable tables={tables} policies={policies} onView={(t: TableHealth) => setViewing(t.tableName)} caption={`${a.name} tables`} />
              </Card>

              {growthTables.length > 0 && (
                <section aria-labelledby="app-growth">
                  <h2 id="app-growth" className="mb-2 text-[13px] font-semibold text-ink-2">
                    Six-month growth · tables over 100,000 records
                  </h2>
                  <div className="grid gap-4 xl:grid-cols-2">
                    {growthTables.map((t) => (
                      <TableGrowthCard key={t.tableName} table={t} thresholds={settings.recordThresholds} />
                    ))}
                  </div>
                </section>
              )}

              <div className="space-y-4">
                <Card title="Archive jobs" actions={<LinkButton href="/archive-jobs" size="sm">All jobs</LinkButton>} flush>
                  <ArchiveJobTable jobs={jobs.slice(0, 5)} appNames={names} caption={`${a.name} archive jobs`} />
                </Card>
                <Card title="Alerts" actions={<LinkButton href="/alerts" size="sm">All alerts</LinkButton>} flush>
                  <AlertTable alerts={alerts.slice(0, 5)} appNames={names} caption={`${a.name} alerts`} />
                </Card>
              </div>
            </div>

            {viewed && (
              <Dialog open onClose={() => setViewing(null)} variant="panel" title={<span className="font-mono">{viewed.tableName}</span>} description={`${a.name} · table detail`} className="w-full">
                <div className="space-y-4">
                  <KeyValueList
                    columns={3}
                    items={[
                      { label: "Retention policy", value: POLICY_LABEL[viewed.policy] },
                      { label: "Date columns", value: <span className="font-mono text-[12px]">{viewed.dateColumns.join(", ")}</span> },
                      { label: "Discovered", value: formatDateTime(viewed.discoveredAt) },
                    ]}
                  />
                  <TableGrowthCard table={viewed} thresholds={settings.recordThresholds} />
                  <LinkButton href="/retention" size="sm">
                    Open retention configuration
                  </LinkButton>
                </div>
              </Dialog>
            )}
          </>
        );
      }}
    </DataState>
  );
}
