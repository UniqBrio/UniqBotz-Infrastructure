"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { combineResources, useApplicationNames, useArchiveJob, useAuditLog } from "@/lib/data/hooks";
import { formatDate, formatDateTime, formatInt, formatMb } from "@/lib/domain/format";
import { Card } from "@/components/ui/Card";
import { DataState } from "@/components/ui/DataState";
import { DemoTag } from "@/components/ui/Badge";
import { KeyValueList } from "@/components/ui/KeyValue";
import { PageHeader } from "@/components/ui/PageHeader";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { CardGridSkeleton, EmptyState } from "@/components/ui/States";
import { LinkButton } from "@/components/ui/Button";
import { ArchiveJobPipeline } from "@/components/archive/ArchiveJobPipeline";
import { DeletionReview } from "@/components/archive/DeletionReview";
import { AuditLogTable } from "@/components/audit/AuditLogTable";
import { JobStatusBadge } from "@/components/status/JobStatusBadge";
import { VerificationStatus } from "@/components/status/VerificationStatus";

export function ArchiveJobDetailView({ jobId }: { jobId: string }) {
  const names = useApplicationNames();
  const all = combineResources({ job: useArchiveJob(jobId), audit: useAuditLog() });

  return (
    <DataState resource={all} loading={<CardGridSkeleton count={3} />}>
      {({ job, audit }) => {
        if (!job) {
          return (
            <Card>
              <EmptyState
                title="Job not found"
                description={`No archive job with id “${jobId}”.`}
                action={<LinkButton href="/archive-jobs">Back to archive jobs</LinkButton>}
              />
            </Card>
          );
        }
        const appName = names[job.applicationId] ?? job.applicationId;
        const related = audit.filter((e) => e.jobId === job.id);
        const d = job.deletion;
        return (
          <>
            <PageHeader
              eyebrow={
                <Link href="/archive-jobs" className="inline-flex items-center gap-1 hover:text-ink">
                  <ArrowLeft className="size-3" aria-hidden /> Archive Jobs
                </Link>
              }
              title={
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-mono">{job.id}</span>
                  <JobStatusBadge status={job.status} size="md" />
                </span>
              }
              description={
                <>
                  {appName} · <span className="font-mono">{job.tables.join(" + ")}</span> · whole days {formatDate(job.boundaryFrom)} →{" "}
                  {formatDate(job.boundaryTo)}
                </>
              }
            />
            <div className="space-y-5">
              <Card title="Safety gate" description="Deletion is impossible unless the stored archive is verified. Verification failure → 0 records deleted.">
                <VerificationStatus job={job} />
              </Card>

              <div className="grid gap-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
                <Card title="Pipeline" description={`Overall progress ${job.progressPct}%`}>
                  <ArchiveJobPipeline steps={job.steps} />
                </Card>
                <div className="space-y-5">
                  <Card title="Deletion">
                    <DeletionReview job={job} appName={appName} />
                    <div className="mt-3">
                      <div className="mb-1 flex justify-between text-xs text-ink-3">
                        <span>
                          Batches {d.batchesCompleted} / {d.batchesTotal} · {formatInt(d.batchSize)} rows per batch
                        </span>
                        <span className="num">
                          {formatInt(d.deletedCount)} / {formatInt(job.selected)} deleted
                        </span>
                      </div>
                      <ProgressBar
                        value={d.batchesTotal ? (d.batchesCompleted / d.batchesTotal) * 100 : 0}
                        tone={d.state === "completed" ? "ok" : d.state === "halted" ? "med" : "neutral"}
                        label="Deletion batches completed"
                      />
                    </div>
                  </Card>
                  <Card title="Job details">
                    <KeyValueList
                      items={[
                        { label: "Application", value: appName },
                        { label: "Tables", value: <span className="font-mono text-[12px]">{job.tables.join(", ")}</span> },
                        { label: "Target", value: formatInt(job.target) },
                        { label: "Selected (frozen)", value: <strong>{formatInt(job.selected)}</strong> },
                        { label: "Oldest day", value: formatDate(job.boundaryFrom) },
                        { label: "Archive boundary", value: formatDate(job.boundaryTo) },
                        { label: "Created", value: formatDateTime(job.createdAt) },
                        { label: "Finished", value: formatDateTime(job.finishedAt) },
                        { label: "Created by", value: job.createdBy },
                        { label: "Format", value: job.archiveFormat },
                        { label: "Archive size", value: <span className="inline-flex items-center gap-1.5">{formatMb(job.archiveSizeMb)} <DemoTag /></span> },
                        {
                          label: "Archive location",
                          value: job.archiveLocation ? (
                            <span className="inline-flex items-center gap-1.5 break-all font-mono text-[11px]">
                              {job.archiveLocation} <DemoTag label="PLACEHOLDER" />
                            </span>
                          ) : (
                            "—"
                          ),
                        },
                      ]}
                    />
                    {job.tables.length > 1 && (
                      <div className="mt-4 border-t border-line pt-3">
                        <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">Selected per table</div>
                        <ul className="mt-1 space-y-0.5 text-[13px]">
                          {Object.entries(job.selectedByTable).map(([t, n]) => (
                            <li key={t} className="flex justify-between">
                              <span className="font-mono text-[12.5px]">{t}</span>
                              <span className="num">{formatInt(n)}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </Card>
                </div>
              </div>

              <Card title="Audit trail for this job" flush>
                <AuditLogTable entries={related} appNames={names} caption={`Audit entries for ${job.id}`} />
              </Card>
            </div>
          </>
        );
      }}
    </DataState>
  );
}
