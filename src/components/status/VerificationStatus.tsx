import { Loader2, Lock, LockOpen, ShieldCheck, ShieldX, Clock } from "lucide-react";
import type { ArchiveJob } from "@/lib/domain/types";
import { isDeletionAllowed } from "@/lib/domain/jobs";
import { formatInt } from "@/lib/domain/format";
import { cn } from "@/lib/cn";

/**
 * The hard safety gate, rendered as two linked panels:
 *   Archive Verification (PASSED / FAILED / RUNNING / PENDING)
 *   Deletion            (ALLOWED / DISABLED / BLOCKED / LOCKED)
 * A failed verification always states "Records deleted: 0".
 */
export function VerificationStatus({ job, compact = false }: { job: ArchiveJob; compact?: boolean }) {
  const v = job.verification;
  const allowed = isDeletionAllowed(job);

  const verif = {
    passed: { label: "PASSED", Icon: ShieldCheck, cls: "border-ok-line bg-ok-soft text-ok-ink" },
    failed: { label: "FAILED", Icon: ShieldX, cls: "border-high-line bg-high-soft text-high-ink" },
    running: { label: "IN PROGRESS", Icon: Loader2, cls: "border-info-line bg-info-soft text-info-ink" },
    pending: { label: "NOT STARTED", Icon: Clock, cls: "border-neutral-line bg-neutral-soft text-ink-2" },
  }[v.state];

  const del = allowed
    ? { label: "ALLOWED", Icon: LockOpen, cls: "border-ok-line bg-ok-soft text-ok-ink", note: "Verification passed — deletion may proceed after operator review." }
    : v.state === "passed" && job.deletion.state === "blocked"
      ? { label: "DISABLED", Icon: Lock, cls: "border-neutral-line bg-neutral-soft text-ink-2", note: "Verification passed, but PRODUCTION DELETION DISABLED (ALLOW_DELETION=false). Approvals are recorded only." }
      : v.state === "failed"
      ? { label: "BLOCKED", Icon: Lock, cls: "border-high-line bg-high-soft text-high-ink", note: "Verification failed — deletion is blocked." }
      : { label: "LOCKED", Icon: Lock, cls: "border-neutral-line bg-neutral-soft text-ink-2", note: "Locked until archive verification passes." };

  return (
    <div className={cn("grid gap-3", !compact && "sm:grid-cols-2")}>
      <div className={cn("rounded-md border p-3", verif.cls)}>
        <div className="text-[11px] font-semibold uppercase tracking-wider opacity-80">Archive verification</div>
        <div className="mt-1 flex items-center gap-2 text-lg font-bold tracking-tight">
          <verif.Icon className={cn("size-5", v.state === "running" && "animate-spin [animation-duration:2.5s]")} aria-hidden />
          {verif.label}
        </div>
        <div className="num mt-1 text-xs">
          Rows verified {formatInt(v.verifiedCount)} / {formatInt(v.expectedCount)} expected
          {v.checksumMatch !== null && <> · checksum {v.checksumMatch ? "match" : "MISMATCH"}</>}
        </div>
        {v.error && <div className="mt-1.5 text-xs font-medium">{v.error}</div>}
      </div>
      <div className={cn("rounded-md border p-3", del.cls)}>
        <div className="text-[11px] font-semibold uppercase tracking-wider opacity-80">Deletion</div>
        <div className="mt-1 flex items-center gap-2 text-lg font-bold tracking-tight">
          <del.Icon className="size-5" aria-hidden />
          {del.label}
        </div>
        <div className="mt-1 text-xs">{del.note}</div>
        <div className="num mt-1.5 text-xs font-semibold">Records deleted: {formatInt(job.deletion.deletedCount)}</div>
      </div>
    </div>
  );
}
