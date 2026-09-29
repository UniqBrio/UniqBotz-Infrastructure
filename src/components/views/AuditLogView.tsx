"use client";

import { useState } from "react";
import type { AuditAction, AuditResult } from "@/lib/domain/types";
import { AUDIT_ACTION_LABEL, AUDIT_RESULT_LABEL } from "@/lib/domain/labels";
import { combineResources, useApplicationNames, useAuditLog } from "@/lib/data/hooks";
import { useScopedAppId } from "@/lib/data/scope";
import { Card } from "@/components/ui/Card";
import { DataState } from "@/components/ui/DataState";
import { SearchInput, Select } from "@/components/ui/Form";
import { PageHeader } from "@/components/ui/PageHeader";
import { LoadingState } from "@/components/ui/States";
import { AuditLogTable } from "@/components/audit/AuditLogTable";
import { ScopeEyebrow } from "./ScopeEyebrow";

export function AuditLogView() {
  const appId = useScopedAppId();
  const names = useApplicationNames();
  const [action, setAction] = useState<"all" | AuditAction>("all");
  const [result, setResult] = useState<"all" | AuditResult>("all");
  const [query, setQuery] = useState("");
  const all = combineResources({ entries: useAuditLog(appId) });

  return (
    <>
      <PageHeader
        eyebrow={<ScopeEyebrow />}
        title="Audit Log"
        description="Append-only record of policy decisions, archive and deletion steps, failures and notifications. Entries created in this session are marked SIMULATED."
      />
      <DataState resource={all} loading={<LoadingState rows={10} />}>
        {({ entries }) => {
          const q = query.trim().toLowerCase();
          const rows = entries.filter(
            (e) =>
              (action === "all" || e.action === action) &&
              (result === "all" || e.result === result) &&
              (!q || [e.tableName ?? "", e.detail ?? "", e.jobId ?? "", e.actor.name].some((s) => s.toLowerCase().includes(q))),
          );
          return (
            <Card
              title={`${rows.length} of ${entries.length} entries`}
              actions={
                <div className="flex flex-wrap items-center gap-2">
                  <Select aria-label="Filter by action" value={action} onChange={(e) => setAction(e.target.value as typeof action)} className="w-48">
                    <option value="all">All actions</option>
                    {(Object.keys(AUDIT_ACTION_LABEL) as AuditAction[]).map((a) => (
                      <option key={a} value={a}>
                        {AUDIT_ACTION_LABEL[a]}
                      </option>
                    ))}
                  </Select>
                  <Select aria-label="Filter by result" value={result} onChange={(e) => setResult(e.target.value as typeof result)} className="w-36">
                    <option value="all">All results</option>
                    {(Object.keys(AUDIT_RESULT_LABEL) as AuditResult[]).map((r) => (
                      <option key={r} value={r}>
                        {AUDIT_RESULT_LABEL[r]}
                      </option>
                    ))}
                  </Select>
                  <SearchInput value={query} onChange={setQuery} placeholder="Table, job, actor…" label="Search audit log" className="w-56" />
                </div>
              }
              flush
            >
              <AuditLogTable entries={rows} appNames={names} caption="Audit log" />
            </Card>
          );
        }}
      </DataState>
    </>
  );
}
