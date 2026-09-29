"use client";

import { combineResources, useApplicationHealthList, useRetentionPolicies, useSettings, useTables } from "@/lib/data/hooks";
import { useScopedAppId } from "@/lib/data/scope";
import { formatDateTime, formatInt, formatMb, formatPct, formatRelative } from "@/lib/domain/format";
import { Card } from "@/components/ui/Card";
import { DataState } from "@/components/ui/DataState";
import { DemoTag } from "@/components/ui/Badge";
import { KeyValueList } from "@/components/ui/KeyValue";
import { PageHeader } from "@/components/ui/PageHeader";
import { CardGridSkeleton } from "@/components/ui/States";
import { DatabaseUsageCard } from "@/components/monitoring/DatabaseUsageCard";
import { TableHealthTable } from "@/components/monitoring/TableHealthTable";
import { ConnectionBadge } from "@/components/status/ConnectionBadge";
import { ScopeEyebrow } from "./ScopeEyebrow";

export function DatabaseHealthView() {
  const appId = useScopedAppId();
  const all = combineResources({
    health: useApplicationHealthList(),
    tables: useTables(appId),
    policies: useRetentionPolicies(appId),
    settings: useSettings(),
  });
  return (
    <>
      <PageHeader
        eyebrow={<ScopeEyebrow />}
        title="Database Health"
        description="Technical view of each application's database: size, capacity, table sizes, index sizes and growth. Size figures are demo estimates in this phase."
      />
      <DataState resource={all} loading={<CardGridSkeleton count={2} />}>
        {({ health, tables, policies, settings }) => (
          <div className="space-y-6">
            {health
              .filter((h) => !appId || h.application.id === appId)
              .map((h) => {
                const a = h.application;
                const appTables = tables.filter((t) => t.applicationId === a.id);
                const indexTotal = appTables.reduce((s, t) => s + t.indexSizeMb, 0);
                return (
                  <section key={a.id} aria-labelledby={`db-${a.id}`} className="space-y-3">
                    <h2 id={`db-${a.id}`} className="text-[15px] font-semibold tracking-tight">
                      {a.name}
                    </h2>
                    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
                      <Card title="Capacity">
                        <DatabaseUsageCard health={h} capacity={settings.capacityThresholdsPct} />
                      </Card>
                      <Card title="Database metrics" actions={<DemoTag label="DEMO VALUES" />}>
                        <KeyValueList
                          columns={4}
                          items={[
                            { label: "Database size", value: formatMb(a.databaseSizeMb) },
                            { label: "Database capacity", value: formatMb(a.databaseCapacityMb) },
                            { label: "Usage", value: formatPct(h.dbUsagePct) },
                            { label: "Table count", value: h.tableCount },
                            { label: "Index size (sum)", value: formatMb(Math.round(indexTotal * 10) / 10) },
                            { label: "Record growth", value: `${formatInt(h.totalAvgDailyGrowth)}/day` },
                            { label: "Last health check", value: <span title={formatDateTime(a.lastHealthCheckAt)}>{formatRelative(a.lastHealthCheckAt)}</span> },
                            { label: "Connection", value: <ConnectionBadge status={a.connectionStatus} /> },
                          ]}
                        />
                        <div className="mt-4 border-t border-line pt-3">
                          <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">Largest tables</div>
                          <ol className="mt-1.5 space-y-1 text-[13px]">
                            {appTables.slice(0, 3).map((t, i) => (
                              <li key={t.tableName} className="flex items-baseline gap-2">
                                <span className="num w-4 text-ink-3">{i + 1}.</span>
                                <span className="font-mono text-[12.5px]">{t.tableName}</span>
                                <span className="num ml-auto text-ink-2">{formatInt(t.rowCount)} rows</span>
                                <span className="num w-20 text-right text-ink-3">{formatMb(t.estimatedSizeMb + t.indexSizeMb)}</span>
                              </li>
                            ))}
                          </ol>
                        </div>
                      </Card>
                    </div>
                    <Card title="Tables" description="Row counts, estimated heap and index sizes, 6-month average growth and retention status." flush>
                      <TableHealthTable tables={appTables} policies={policies} variant="technical" caption={`${a.name} table health`} />
                    </Card>
                  </section>
                );
              })}
            <p className="text-xs text-ink-3">
              Note: in PostgreSQL, deleting rows does not immediately reduce on-disk size — space is reclaimed by vacuum. The backend
              phase will surface bloat and vacuum status here.
            </p>
          </div>
        )}
      </DataState>
    </>
  );
}
