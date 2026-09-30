"use client";

import { AlertOctagon, CheckCircle2, Lock, PauseCircle, ShieldCheck } from "lucide-react";
import { useState } from "react";
import type { ArchiveJob } from "@/lib/domain/types";
import { canReviewDeletion } from "@/lib/domain/jobs";
import { formatInt } from "@/lib/domain/format";
import type { DeletionSimulationResult } from "@/lib/data/source";
import { useMutations } from "@/lib/data/hooks";
import { Button } from "@/components/ui/Button";
import { ConfirmationDialog } from "@/components/ui/ConfirmationDialog";

/**
 * The deletion step, deliberately separated from ordinary actions:
 *   Archive Verified ✓ → [Review Deletion] → typed confirmation → (simulated) confirm.
 * In Phase 1 confirmation never deletes anything; the data source refuses
 * outright when verification has not passed.
 */
export function DeletionReview({ job, appName }: { job: ArchiveJob; appName: string }) {
  const { source } = useMutations();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DeletionSimulationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tables = job.tables.join(", ");

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await source.simulateDeletionConfirmation(job.id));
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (source.mode === "live" && job.verification.state !== "failed" && job.deletion.state !== "completed" && job.deletion.state !== "halted") {
    return (
      <Panel tone="neutral" Icon={Lock} title="Deletion disabled in this deployment">
        <p>
          <strong>ALLOW_DELETION=false.</strong> This job can be archived and verified, but no deletion can be requested from the dashboard.
          Records deleted: <strong className="num">0</strong>.
        </p>
      </Panel>
    );
  }

  if (job.verification.state === "failed") {
    return (
      <Panel tone="high" Icon={AlertOctagon} title="Deletion blocked — archive verification failed">
        <p>
          <strong className="num text-base">Records deleted: 0</strong>
        </p>
        <p>The source data is untouched. A new archive must be created and verified before deletion can ever be reviewed.</p>
      </Panel>
    );
  }

  if (job.deletion.state === "completed") {
    return (
      <Panel tone="ok" Icon={CheckCircle2} title="Deletion completed and verified">
        <p className="num">
          {formatInt(job.deletion.deletedCount)} records deleted in {job.deletion.batchesCompleted} batches of {formatInt(job.deletion.batchSize)}.
        </p>
      </Panel>
    );
  }

  if (job.deletion.state === "halted") {
    return (
      <Panel tone="med" Icon={PauseCircle} title="Deletion halted — requires review">
        <p className="num">
          {formatInt(job.deletion.deletedCount)} of {formatInt(job.selected)} verified records deleted ({job.deletion.batchesCompleted}/
          {job.deletion.batchesTotal} batches). Remaining work is resumable from the next batch; only records in the verified
          candidate set can be deleted.
        </p>
        <Button size="sm" disabled title="Resume is implemented in the backend phase" className="mt-2">
          <Lock className="size-3.5" aria-hidden /> Resume deletion (backend phase)
        </Button>
      </Panel>
    );
  }

  if (!canReviewDeletion(job)) {
    return (
      <Panel tone="neutral" Icon={Lock} title="Deletion locked">
        <p>Deletion can only be reviewed after the archive has been created and verification has PASSED.</p>
        <Button size="sm" disabled className="mt-2">
          <Lock className="size-3.5" aria-hidden /> Review Deletion
        </Button>
      </Panel>
    );
  }

  return (
    <>
      <Panel tone="ok" Icon={ShieldCheck} title="Archive verified ✓">
        <p className="num">
          Records: <strong className="text-base">{formatInt(job.selected)}</strong>
        </p>
        <p>Deletion is allowed, but requires an explicit operator review.</p>
        {result ? (
          <div role="status" className="mt-2 rounded-md border border-info-line bg-info-soft px-3 py-2 text-xs text-info-ink">
            <strong>Simulation recorded.</strong> {result.message} Records that would be deleted:{" "}
            <span className="num">{formatInt(result.recordsThatWouldBeDeleted)}</span> · Records deleted:{" "}
            <strong className="num">{result.recordsDeleted}</strong>.
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-high-line bg-surface px-3 py-1.5 text-[13px] font-semibold text-high-ink hover:bg-high-soft"
          >
            <Lock className="size-3.5" aria-hidden /> Review Deletion
          </button>
        )}
        {error && (
          <p role="alert" className="mt-2 text-xs font-medium text-high-ink">
            {error}
          </p>
        )}
      </Panel>

      <ConfirmationDialog
        open={open}
        onClose={() => setOpen(false)}
        onConfirm={confirm}
        busy={busy}
        title="Review deletion"
        confirmLabel="Confirm Deletion (simulated)"
        confirmPhrase={job.id}
      >
        <div className="space-y-3 text-[13px]">
          <p>You are about to delete:</p>
          <div className="rounded-md border border-line bg-surface-2 p-3">
            <div className="num text-2xl font-semibold tracking-tight">{formatInt(job.selected)} records</div>
            <div className="mt-1 text-ink-2">
              from <span className="font-mono font-medium text-ink">{tables}</span> in <strong>{appName}</strong>
            </div>
            <div className="mt-1 text-xs text-ink-3">
              Boundary {job.boundaryFrom} → {job.boundaryTo} · batches of {formatInt(job.deletion.batchSize)}
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-md border border-ok-line bg-ok-soft px-3 py-2 text-ok-ink">
            <ShieldCheck className="size-4" aria-hidden />
            Archive verification: <strong>PASSED</strong>
            <span className="num ml-auto text-xs">
              {formatInt(job.verification.verifiedCount)} / {formatInt(job.verification.expectedCount)} · checksum match
            </span>
          </div>
          <p className="font-semibold text-high-ink">This operation cannot be automatically reversed.</p>
          <p className="rounded-md border border-info-line bg-info-soft px-3 py-2 text-xs text-info-ink">
            Prototype: confirming records a simulated audit entry only. No database is connected and no records will be deleted.
          </p>
        </div>
      </ConfirmationDialog>
    </>
  );
}

function Panel({
  tone,
  Icon,
  title,
  children,
}: {
  tone: "ok" | "high" | "med" | "neutral";
  Icon: typeof Lock;
  title: string;
  children: React.ReactNode;
}) {
  const cls = {
    ok: "border-ok-line bg-ok-soft/50",
    high: "border-high-line bg-high-soft/60",
    med: "border-med-line bg-med-soft/60",
    neutral: "border-line bg-surface-2",
  }[tone];
  const icon = { ok: "text-ok-ink", high: "text-high-ink", med: "text-med-ink", neutral: "text-ink-3" }[tone];
  return (
    <div className={`rounded-md border p-3 ${cls}`}>
      <div className="flex items-center gap-2 text-[13px] font-semibold">
        <Icon className={`size-4 ${icon}`} aria-hidden />
        {title}
      </div>
      <div className="mt-1.5 space-y-1 text-xs text-ink-2">{children}</div>
    </div>
  );
}
