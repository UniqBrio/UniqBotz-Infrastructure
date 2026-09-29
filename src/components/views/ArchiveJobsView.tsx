"use client";

import { useState } from "react";
import type { ArchiveJob, ArchiveJobStatus } from "@/lib/domain/types";
import { combineResources, useApplicationNames, useArchiveJobs } from "@/lib/data/hooks";
import { useScopedAppId } from "@/lib/data/scope";
import { isActiveJob } from "@/lib/domain/jobs";
import { Card } from "@/components/ui/Card";
import { DataState } from "@/components/ui/DataState";
import { SegmentedControl } from "@/components/ui/Form";
import { PageHeader } from "@/components/ui/PageHeader";
import { LoadingState } from "@/components/ui/States";
import { ArchiveJobTable } from "@/components/archive/ArchiveJobTable";
import { JobStatusBadge } from "@/components/status/JobStatusBadge";
import { ScopeEyebrow } from "./ScopeEyebrow";

type Filter = "all" | "active" | "attention" | "completed";

const FILTERS: Record<Filter, (j: ArchiveJob) => boolean> = {
  all: () => true,
  active: isActiveJob,
  attention: (j) => j.status === "failed" || j.status === "requires_review" || j.status === "ready_for_deletion",
  completed: (j) => j.status === "completed",
};

const LIFECYCLE: ArchiveJobStatus[] = [
  "preparing",
  "selecting",
  "exporting",
  "verifying",
  "ready_for_deletion",
  "deleting",
  "completed",
];

export function ArchiveJobsView() {
  const appId = useScopedAppId();
  const names = useApplicationNames();
  const [filter, setFilter] = useState<Filter>("all");
  const all = combineResources({ jobs: useArchiveJobs(appId) });

  return (
    <>
      <PageHeader
        eyebrow={<ScopeEyebrow />}
        title="Archive Jobs"
        description="Every archive run is a job with a visible, resumable lifecycle. Deletion is only reachable after archive verification passes and an operator reviews it. No job executes in this prototype."
      />
      <Card title="Job lifecycle" className="mb-5">
        <div className="flex flex-wrap items-center gap-1.5 text-ink-3">
          {LIFECYCLE.map((s, i) => (
            <span key={s} className="inline-flex items-center gap-1.5">
              <JobStatusBadge status={s} />
              {i < LIFECYCLE.length - 1 && <span aria-hidden>→</span>}
            </span>
          ))}
          <span className="mx-2 h-4 w-px bg-line" aria-hidden />
          <span className="text-xs">Exit states:</span>
          <JobStatusBadge status="failed" />
          <JobStatusBadge status="requires_review" />
        </div>
      </Card>
      <DataState resource={all} loading={<LoadingState rows={8} />}>
        {({ jobs }) => {
          const count = (f: Filter) => jobs.filter(FILTERS[f]).length;
          return (
            <Card
              title="Jobs"
              actions={
                <SegmentedControl<Filter>
                  label="Filter jobs"
                  size="sm"
                  value={filter}
                  onChange={setFilter}
                  options={[
                    { value: "all", label: "All", count: count("all") },
                    { value: "active", label: "Active", count: count("active") },
                    { value: "attention", label: "Needs action", count: count("attention") },
                    { value: "completed", label: "Completed", count: count("completed") },
                  ]}
                />
              }
              flush
            >
              <ArchiveJobTable jobs={jobs.filter(FILTERS[filter])} appNames={names} caption="Archive jobs" />
            </Card>
          );
        }}
      </DataState>
    </>
  );
}
