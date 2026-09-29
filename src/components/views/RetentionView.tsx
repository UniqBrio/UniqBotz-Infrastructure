"use client";

import { useState } from "react";
import type { RetentionPolicyKind } from "@/lib/domain/types";
import { combineResources, useApplications, useRetentionPolicies, useSettings, useTables } from "@/lib/data/hooks";
import { useScopedAppId } from "@/lib/data/scope";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { DataState } from "@/components/ui/DataState";
import { SearchInput, SegmentedControl } from "@/components/ui/Form";
import { PageHeader } from "@/components/ui/PageHeader";
import { LoadingState } from "@/components/ui/States";
import { RetentionFlowStrip } from "@/components/retention/RetentionFlowStrip";
import { RetentionPolicyEditor } from "@/components/retention/RetentionPolicyEditor";
import { RetentionPolicyTable, type PolicyRow } from "@/components/retention/RetentionPolicyTable";
import { ScopeEyebrow } from "./ScopeEyebrow";

type Filter = "all" | RetentionPolicyKind;

export function RetentionView() {
  const appId = useScopedAppId();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<{ applicationId: string; tableName: string } | null>(null);
  const all = combineResources({
    apps: useApplications(),
    tables: useTables(appId),
    policies: useRetentionPolicies(appId),
    settings: useSettings(),
  });

  return (
    <>
      <PageHeader
        eyebrow={<ScopeEyebrow />}
        title="Retention Configuration"
        description="Supabase discovers the tables. The operator decides the retention policy. Newly discovered tables always start as Review Required and are never archived automatically."
      />
      <div className="mb-5">
        <RetentionFlowStrip />
      </div>
      <DataState resource={all} loading={<LoadingState rows={8} />}>
        {({ apps, tables, policies, settings }) => {
          const rowsAll: PolicyRow[] = tables
            .map((t) => ({ table: t, policy: policies.find((p) => p.applicationId === t.applicationId && p.tableName === t.tableName)! }))
            .filter((r) => r.policy);
          const count = (k: RetentionPolicyKind) => rowsAll.filter((r) => r.policy.policy === k).length;
          const q = query.trim().toLowerCase();
          const rows = rowsAll.filter((r) => (filter === "all" || r.policy.policy === filter) && (!q || r.table.tableName.toLowerCase().includes(q)));
          const editRow = editing ? rowsAll.find((r) => r.table.applicationId === editing.applicationId && r.table.tableName === editing.tableName) : undefined;
          const scopedApps = apps.filter((a) => !appId || a.id === appId);

          return (
            <div className="space-y-5">
              <div className="flex flex-wrap items-center gap-3">
                <SegmentedControl<Filter>
                  label="Filter by policy"
                  value={filter}
                  onChange={setFilter}
                  options={[
                    { value: "all", label: "All", count: rowsAll.length },
                    { value: "review_required", label: "Review Required", count: count("review_required") },
                    { value: "archive", label: "Archive", count: count("archive") },
                    { value: "dont_archive", label: "Don't Archive", count: count("dont_archive") },
                  ]}
                />
                <SearchInput value={query} onChange={setQuery} placeholder="Search tables…" label="Search tables" className="w-full sm:w-64" />
              </div>

              {scopedApps.map((a) => {
                const appRows = rows.filter((r) => r.table.applicationId === a.id);
                const appAll = rowsAll.filter((r) => r.table.applicationId === a.id);
                const review = appAll.filter((r) => r.policy.policy === "review_required").length;
                const active = appAll.filter((r) => r.policy.policy === "archive" && r.policy.enabled).length;
                return (
                  <Card
                    key={a.id}
                    title={<>Application: {a.name}</>}
                    description={`${appAll.length} tables discovered · ${active} enabled for archival`}
                    actions={
                      review > 0 ? (
                        <Badge tone="low" size="sm">
                          {review} awaiting decision
                        </Badge>
                      ) : (
                        <Badge tone="ok" size="sm">
                          All tables decided
                        </Badge>
                      )
                    }
                    flush
                  >
                    <RetentionPolicyTable
                      rows={appRows}
                      caption={`${a.name} retention configuration`}
                      onEdit={(r) => setEditing({ applicationId: r.table.applicationId, tableName: r.table.tableName })}
                    />
                  </Card>
                );
              })}

              {editRow && (
                <RetentionPolicyEditor
                  key={`${editRow.table.applicationId}.${editRow.table.tableName}`}
                  open
                  onClose={() => setEditing(null)}
                  table={editRow.table}
                  policy={editRow.policy}
                  appName={apps.find((a) => a.id === editRow.table.applicationId)?.name ?? editRow.table.applicationId}
                  defaultTarget={settings.defaultArchiveTarget}
                />
              )}
            </div>
          );
        }}
      </DataState>
    </>
  );
}
