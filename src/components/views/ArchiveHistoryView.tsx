"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ShieldCheck, ShieldX, Loader2, Clock } from "lucide-react";
import type { ArchiveJob } from "@/lib/domain/types";
import { combineResources, useApplicationNames, useArchiveJobs } from "@/lib/data/hooks";
import { useScopedAppId } from "@/lib/data/scope";
import { formatDate, formatInt, formatMb } from "@/lib/domain/format";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { DataState } from "@/components/ui/DataState";
import { SearchInput, SegmentedControl } from "@/components/ui/Form";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState, LoadingState } from "@/components/ui/States";
import { Table, TD, TH, THead, TR } from "@/components/ui/Table";
import { JobStatusBadge } from "@/components/status/JobStatusBadge";
import { ScopeEyebrow } from "./ScopeEyebrow";

type Filter = "all" | "completed" | "failed" | "requires_review";

function VerificationCell({ job }: { job: ArchiveJob }) {
  const v = job.verification.state;
  if (v === "passed") return <Badge tone="ok" icon={<ShieldCheck className="size-3" aria-hidden />}>PASSED</Badge>;
  if (v === "failed") return <Badge tone="high" icon={<ShieldX className="size-3" aria-hidden />}>FAILED</Badge>;
  if (v === "running") return <Badge tone="info" icon={<Loader2 className="size-3" aria-hidden />}>RUNNING</Badge>;
  return <Badge tone="neutral" icon={<Clock className="size-3" aria-hidden />}>PENDING</Badge>;
}

export function ArchiveHistoryView() {
  const appId = useScopedAppId();
  const names = useApplicationNames();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const all = combineResources({ jobs: useArchiveJobs(appId) });

  return (
    <>
      <PageHeader
        eyebrow={<ScopeEyebrow />}
        title="Archive History"
        description="Finished archive runs. Records are only ever deleted after a verified archive exists — failed verification always shows 0 deleted."
      />
      <DataState resource={all} loading={<LoadingState rows={8} />}>
        {({ jobs }) => {
          const finished = jobs.filter((j) => j.status === "completed" || j.status === "failed" || j.status === "requires_review");
          const q = query.trim().toLowerCase();
          const rows = finished.filter(
            (j) =>
              (filter === "all" || j.status === filter) &&
              (!q || [j.id, names[j.applicationId] ?? "", ...j.tables].some((s) => s.toLowerCase().includes(q))),
          );
          const archived = finished.filter((j) => j.verification.state === "passed").reduce((s, j) => s + j.selected, 0);
          const deleted = finished.reduce((s, j) => s + j.deletion.deletedCount, 0);
          return (
            <Card
              title="History"
              description={`${formatInt(archived)} records archived with verification · ${formatInt(deleted)} deleted`}
              actions={
                <div className="flex flex-wrap items-center gap-2">
                  <SegmentedControl<Filter>
                    label="Filter history"
                    size="sm"
                    value={filter}
                    onChange={setFilter}
                    options={[
                      { value: "all", label: "All" },
                      { value: "completed", label: "Completed" },
                      { value: "failed", label: "Failed" },
                      { value: "requires_review", label: "Requires review" },
                    ]}
                  />
                  <SearchInput value={query} onChange={setQuery} placeholder="Job, application, table…" label="Search archive history" className="w-60" />
                </div>
              }
              flush
            >
              {rows.length === 0 ? (
                <EmptyState title="No matching archive runs" description="Adjust the search or filter." />
              ) : (
                <Table caption="Archive history">
                  <THead>
                    <tr>
                      <TH>Date</TH>
                      <TH>Job</TH>
                      <TH>Application</TH>
                      <TH>Tables</TH>
                      <TH align="right">Records archived</TH>
                      <TH align="right">Records deleted</TH>
                      <TH align="right">Archive size</TH>
                      <TH>Verification</TH>
                      <TH>Status</TH>
                    </tr>
                  </THead>
                  <tbody>
                    {rows.map((j) => (
                      <TR key={j.id} className="cursor-pointer hover:bg-surface-2" onClick={() => router.push(`/archive-jobs/${j.id}`)}>
                        <TD className="whitespace-nowrap">{formatDate(j.finishedAt ?? j.startedAt)}</TD>
                        <TD>
                          <Link href={`/archive-jobs/${j.id}`} className="font-mono text-[12.5px] font-semibold text-accent hover:underline" onClick={(e) => e.stopPropagation()}>
                            {j.id}
                          </Link>
                        </TD>
                        <TD className="whitespace-nowrap">{names[j.applicationId] ?? j.applicationId}</TD>
                        <TD className="font-mono text-[12px]">{j.tables.join(" + ")}</TD>
                        <TD align="right">
                          {j.verification.state === "passed" ? formatInt(j.selected) : <span className="text-ink-3">Not verified</span>}
                        </TD>
                        <TD align="right" className={j.verification.state === "failed" ? "font-semibold text-high-ink" : undefined}>
                          {formatInt(j.deletion.deletedCount)}
                        </TD>
                        <TD align="right">{formatMb(j.archiveSizeMb)}</TD>
                        <TD>
                          <VerificationCell job={j} />
                        </TD>
                        <TD>
                          <JobStatusBadge status={j.status} />
                        </TD>
                      </TR>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>
          );
        }}
      </DataState>
    </>
  );
}
