"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ArchiveJob } from "@/lib/domain/types";
import { formatDateTime, formatInt } from "@/lib/domain/format";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { Table, TD, TH, THead, TR } from "@/components/ui/Table";
import { EmptyState } from "@/components/ui/States";
import { JobStatusBadge } from "@/components/status/JobStatusBadge";
import { PipelineMini } from "./ArchiveJobPipeline";

export function ArchiveJobTable({ jobs, appNames, caption }: { jobs: ArchiveJob[]; appNames: Record<string, string>; caption: string }) {
  const router = useRouter();
  if (jobs.length === 0) return <EmptyState title="No archive jobs" description="No jobs match the current scope and filters." />;
  return (
    <Table caption={caption}>
      <THead>
        <tr>
          <TH>Job ID</TH>
          <TH>Application</TH>
          <TH>Tables</TH>
          <TH align="right">Target</TH>
          <TH align="right">Selected</TH>
          <TH>Status</TH>
          <TH>Started</TH>
          <TH>Progress</TH>
        </tr>
      </THead>
      <tbody>
        {jobs.map((j) => (
          <TR key={j.id} className="cursor-pointer hover:bg-surface-2" onClick={() => router.push(`/archive-jobs/${j.id}`)}>
            <TD>
              <Link href={`/archive-jobs/${j.id}`} className="font-mono text-[12.5px] font-semibold text-accent hover:underline" onClick={(e) => e.stopPropagation()}>
                {j.id}
              </Link>
            </TD>
            <TD className="whitespace-nowrap">{appNames[j.applicationId] ?? j.applicationId}</TD>
            <TD className="font-mono text-[12px]">{j.tables.join(" + ")}</TD>
            <TD align="right">{formatInt(j.target)}</TD>
            <TD align="right" className="font-medium">
              {formatInt(j.selected)}
            </TD>
            <TD>
              <JobStatusBadge status={j.status} />
            </TD>
            <TD className="whitespace-nowrap text-xs text-ink-2">{formatDateTime(j.startedAt)}</TD>
            <TD className="min-w-40">
              <div className="flex items-center gap-2">
                <ProgressBar
                  value={j.progressPct}
                  className="w-20"
                  tone={j.status === "failed" ? "high" : j.status === "completed" ? "ok" : j.status === "requires_review" || j.status === "ready_for_deletion" ? "low" : "info"}
                  label={`${j.id} progress ${j.progressPct}%`}
                />
                <span className="num w-9 text-right text-xs text-ink-2">{j.progressPct}%</span>
                <PipelineMini steps={j.steps} />
              </div>
            </TD>
          </TR>
        ))}
      </tbody>
    </Table>
  );
}
