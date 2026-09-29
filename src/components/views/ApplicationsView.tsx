"use client";

import Link from "next/link";
import { Plus } from "lucide-react";
import { combineResources, useApplicationHealthList, useSettings } from "@/lib/data/hooks";
import { formatMb, formatPct, formatRelative } from "@/lib/domain/format";
import { Card } from "@/components/ui/Card";
import { DataState } from "@/components/ui/DataState";
import { PageHeader } from "@/components/ui/PageHeader";
import { CardGridSkeleton, EmptyState } from "@/components/ui/States";
import { Table, TD, TH, THead, TR } from "@/components/ui/Table";
import { ApplicationCard } from "@/components/monitoring/ApplicationCard";
import { ConnectionBadge } from "@/components/status/ConnectionBadge";
import { HealthStatusBadge } from "@/components/status/HealthStatusBadge";
import { SeverityBadge } from "@/components/status/SeverityBadge";

export function ApplicationsView() {
  const all = combineResources({ health: useApplicationHealthList(), settings: useSettings() });
  return (
    <>
      <PageHeader
        title="Applications"
        description="Every UniqBotz product is registered here as an independent Supabase project with its own schema. The same monitoring and retention model applies to each — future applications join the same structure."
      />
      <DataState resource={all} loading={<CardGridSkeleton />}>
        {({ health, settings }) =>
          health.length === 0 ? (
            <Card>
              <EmptyState title="No applications registered" description="Register an application's Supabase project to start monitoring (backend phase)." />
            </Card>
          ) : (
            <div className="space-y-6">
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {health.map((h) => (
                  <ApplicationCard key={h.application.id} health={h} capacity={settings.capacityThresholdsPct} />
                ))}
                <div className="flex min-h-48 flex-col items-center justify-center rounded-lg border border-dashed border-line-strong p-6 text-center">
                  <Plus className="mb-1 size-5 text-ink-3" aria-hidden />
                  <p className="text-[13px] font-semibold">Register application</p>
                  <p className="mt-1 max-w-64 text-xs text-ink-3">
                    Future UniqBotz applications connect their own Supabase project and appear here automatically. Available in the
                    backend phase.
                  </p>
                </div>
              </div>

              <Card title="Application registry" flush>
                <Table caption="Registered applications">
                  <THead>
                    <tr>
                      <TH>Application</TH>
                      <TH>Status</TH>
                      <TH>Severity</TH>
                      <TH>Supabase</TH>
                      <TH align="right">Database</TH>
                      <TH align="right">Usage</TH>
                      <TH align="right">Tables</TH>
                      <TH>Last check</TH>
                    </tr>
                  </THead>
                  <tbody>
                    {health.map((h) => (
                      <TR key={h.application.id} className="hover:bg-surface-2">
                        <TD>
                          <Link href={`/applications/${h.application.id}`} className="font-semibold text-accent hover:underline">
                            {h.application.name}
                          </Link>
                          <div className="font-mono text-[10px] text-ink-3">{h.application.supabaseProjectRef}</div>
                        </TD>
                        <TD>
                          <HealthStatusBadge status={h.status} />
                        </TD>
                        <TD>
                          <SeverityBadge severity={h.overallSeverity} />
                        </TD>
                        <TD>
                          <ConnectionBadge status={h.application.connectionStatus} />
                        </TD>
                        <TD align="right">
                          {formatMb(h.application.databaseSizeMb)} / {formatMb(h.application.databaseCapacityMb)}
                        </TD>
                        <TD align="right">{formatPct(h.dbUsagePct)}</TD>
                        <TD align="right">{h.tableCount}</TD>
                        <TD className="whitespace-nowrap text-xs text-ink-2">{formatRelative(h.application.lastHealthCheckAt)}</TD>
                      </TR>
                    ))}
                  </tbody>
                </Table>
              </Card>
            </div>
          )
        }
      </DataState>
    </>
  );
}
