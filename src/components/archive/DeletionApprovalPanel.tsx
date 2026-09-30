"use client";

import { Ban, CheckCircle2, CircleDashed, Lock, ShieldAlert, XCircle } from "lucide-react";
import { useState } from "react";
import type { DeletionReviewData, SessionInfo } from "@/lib/domain/types";
import { formatDateTime, formatInt, formatMb } from "@/lib/domain/format";
import { useDeletionReview, useMutations, useSession } from "@/lib/data/hooks";
import { cn } from "@/lib/cn";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { KeyValueList } from "@/components/ui/KeyValue";

type StepState = "done" | "blocked" | "pending";

const short = (h: string | null) => (h ? `${h.slice(0, 12)}…${h.slice(-6)}` : "—");

function steps(r: DeletionReviewData): { label: string; state: StepState; note: string }[] {
  const verified = r.verification?.verified === true;
  const countingApprovals = r.approvals.filter((a) => a.counts).length;
  const liveAuth = r.authorizations.find((a) => !a.revokedAt);
  const policyReady = r.policy.gaps.length === 0;
  return [
    { label: "Archive verified", state: verified ? "done" : "blocked", note: verified ? "all 6 gate stages passed" : "verification has not passed" },
    { label: "Deletion review", state: verified ? "done" : "pending", note: "evidence below" },
    {
      label: "Approval",
      state: r.mode !== "ARCHIVE_VERIFY_DELETE" || !policyReady ? "blocked" : policyReady && countingApprovals >= (r.policy.requiredApprovers ?? Infinity) ? "done" : "pending",
      note: r.mode !== "ARCHIVE_VERIFY_DELETE" ? "archive-and-verify-only job" : !policyReady ? "approval policy not configured" : `${countingApprovals} of ${r.policy.requiredApprovers} valid`,
    },
    { label: "Deletion authorization", state: liveAuth ? "done" : r.mode !== "ARCHIVE_VERIFY_DELETE" || !policyReady ? "blocked" : "pending", note: liveAuth ? `expires ${formatDateTime(liveAuth.expiresAt)}` : "explicit ADMIN authorization" },
    { label: "Worker execution", state: "blocked", note: "PRODUCTION DELETION DISABLED" },
  ];
}

function StepIcon({ state }: { state: StepState }) {
  if (state === "done") return <CheckCircle2 className="size-4 text-ok" aria-hidden />;
  if (state === "blocked") return <Ban className="size-4 text-high" aria-hidden />;
  return <CircleDashed className="size-4 text-ink-3" aria-hidden />;
}

function ApprovalControls({ review, session, onDone }: { review: DeletionReviewData; session: SessionInfo; onDone: () => void }) {
  const { source } = useMutations();
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const allowed = session.permissions.includes("approve_deletion");
  const eligible = review.mode === "ARCHIVE_VERIFY_DELETE" && review.status === "ready_for_deletion" && review.verification?.verified && review.policy.gaps.length === 0;
  if (!allowed || !eligible) {
    return (
      <p className="text-xs text-ink-2">
        {!session.authenticated
          ? `Recording an approval requires a signed-in APPROVER (${session.notice ?? "authentication not configured"}).`
          : !allowed
            ? "Your account does not hold the APPROVER role."
            : "This job cannot be approved in its current state (see blockers)."}
      </p>
    );
  }
  const decide = async (decision: "approve" | "reject") => {
    setBusy(true);
    setError(null);
    try {
      await source.submitApprovalDecision(review.jobId, decision, review.evidence, comment || undefined);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      <label className="block text-xs font-medium text-ink-2" htmlFor="approval-comment">Comment (recorded in the audit log)</label>
      <textarea id="approval-comment" value={comment} onChange={(e) => setComment(e.target.value)} rows={2}
        className="w-full rounded-md border border-line bg-surface px-2 py-1.5 text-[13px]" />
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => decide("approve")} disabled={busy}>Record approval (does not delete)</Button>
        <Button onClick={() => decide("reject")} disabled={busy}>Reject</Button>
        <span className="text-[11px] text-ink-3">Your decision is bound to attempt {review.evidence.attempt}, manifest {short(review.evidence.manifestSha256)}.</span>
      </div>
      {error && <p className="text-xs font-medium text-high-ink">{error}</p>}
    </div>
  );
}

/**
 * Phase 3C approval workflow view: Archive Verified → Deletion Review → Approval → Deletion Authorization →
 * Worker Execution. There is NO delete button: execution belongs to the worker, and it is disabled.
 */
export function DeletionApprovalPanel({ jobId }: { jobId: string }) {
  const review = useDeletionReview(jobId);
  const session = useSession();
  const r = review.data;
  if (!r || !session.data) return null;
  const v = r.verification;
  return (
    <Card
      title="Deletion approval workflow"
      description="Approvals and authorization are recorded decisions only. The worker re-validates every gate and remains the final authority."
      actions={<Badge tone="high" size="sm" icon={<Lock className="size-3" aria-hidden />}>PRODUCTION DELETION DISABLED</Badge>}
    >
      <div className="space-y-5">
        <div role="note" className="flex items-start gap-2 rounded-md border border-high-line bg-high-soft px-3 py-2 text-sm text-high-ink">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p>
            <strong>PRODUCTION DELETION DISABLED.</strong> No approval, authorization or button on this page can delete data. Records deleted:{" "}
            <strong className="num">0</strong>.
          </p>
        </div>

        <ol className="grid gap-2 sm:grid-cols-5" aria-label="Deletion workflow">
          {steps(r).map((s, i) => (
            <li key={s.label} className={cn("rounded-md border px-2.5 py-2", s.state === "done" ? "border-ok-line bg-ok-soft" : s.state === "blocked" ? "border-high-line bg-high-soft" : "border-line bg-surface-2")}>
              <div className="flex items-center gap-1.5 text-[12px] font-semibold text-ink">
                <StepIcon state={s.state} /> {i + 1}. {s.label}
              </div>
              <div className="mt-0.5 text-[11px] text-ink-2">{s.note}</div>
            </li>
          ))}
        </ol>

        <div>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-3">Evidence reviewed</h3>
          <KeyValueList
            columns={3}
            items={[
              { label: "Job ID", value: <span className="font-mono">{r.jobId}</span> },
              { label: "Application", value: `${r.applicationName} (${r.environment})` },
              { label: "Mode", value: <span className="font-mono text-[12px]">{r.mode}</span> },
              { label: "Tables", value: <span className="font-mono text-[12px]">{r.tables.join(", ")}</span> },
              { label: "Candidate count (frozen)", value: <strong>{formatInt(r.candidateCount)}</strong> },
              { label: "Archive boundary", value: r.oldestDay && r.boundaryDay ? `${r.oldestDay} → ${r.boundaryDay} (whole days)` : "—" },
              { label: "Archive checksum (manifest SHA-256)", value: <span className="font-mono text-[12px]" title={r.evidence.manifestSha256 ?? ""}>{short(r.evidence.manifestSha256)}</span> },
              { label: "Verification result", value: v ? (v.verified ? `PASSED · ${formatDateTime(v.verifiedAt)}` : `FAILED at ${v.failedStage}`) : "not run" },
              { label: "Schema hash", value: <span className="font-mono text-[12px]" title={r.evidence.schemaHash ?? ""}>{short(r.evidence.schemaHash)}{v?.schemaHashPassed ? " ✓ unchanged" : ""}</span> },
              {
                label: "Candidate fingerprint verification",
                value: v?.keySetPassed && v.restoreFingerprintPassed && r.candidateSetIntact ? "✓ key set + full restore fingerprints match" : "✗ not verified",
              },
              { label: "Candidate-set digest", value: <span className="font-mono text-[12px]" title={r.evidence.candidateDigest ?? ""}>{short(r.evidence.candidateDigest)}</span> },
              { label: "Archive size (data)", value: formatMb(r.archiveDataBytes / 1048576) },
            ]}
          />
        </div>

        <div>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-3">Estimated database impact</h3>
          <table className="w-full text-left text-[12px]">
            <thead className="text-ink-3">
              <tr><th className="py-1 font-medium">Table</th><th className="py-1 font-medium">Rows to delete</th><th className="py-1 font-medium">Of table</th><th className="py-1 font-medium">Est. reusable heap space</th></tr>
            </thead>
            <tbody>
              {r.impact.map((i) => (
                <tr key={i.table} className="border-t border-line">
                  <td className="py-1 font-mono">{i.table}</td>
                  <td className="num py-1">{formatInt(i.rowsToDelete)}</td>
                  <td className="num py-1">{i.pctOfTable === null ? "—" : `${i.pctOfTable}% of ${formatInt(i.tableRows)}`}</td>
                  <td className="num py-1">{i.estReusableBytes === null ? "—" : formatMb(i.estReusableBytes / 1048576)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1 text-[11px] text-ink-3">Estimate. Freed space is reused by Postgres after VACUUM; it is not returned to the plan quota (VACUUM FULL is never run).</p>
        </div>

        <div className="grid gap-5 lg:grid-cols-2">
          <div>
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-3">Approval history</h3>
            {r.approvals.length === 0 ? (
              <p className="text-xs text-ink-2">No approval decisions recorded.</p>
            ) : (
              <ul className="space-y-1.5 text-[12px]">
                {r.approvals.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center gap-2">
                    {a.decision === "approve" ? <CheckCircle2 className="size-3.5 text-ok" aria-hidden /> : <XCircle className="size-3.5 text-high" aria-hidden />}
                    <strong>{a.operator}</strong> {a.decision === "approve" ? "approved" : "rejected"} · {formatDateTime(a.decidedAt)}
                    {a.expiresAt && <span className="text-ink-3">· expires {formatDateTime(a.expiresAt)}</span>}
                    {!a.counts && a.decision === "approve" && <Badge tone="med" size="xs">not counting: {a.notCountingReason}</Badge>}
                  </li>
                ))}
              </ul>
            )}
            {r.authorizations.map((a) => (
              <p key={a.id} className="mt-2 text-[12px]">
                Authorized by <strong>{a.operator}</strong> · {formatDateTime(a.authorizedAt)} · expires {formatDateTime(a.expiresAt)}
                {a.revokedAt ? " · REVOKED" : ""}
              </p>
            ))}
          </div>
          <div>
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-3">Why this job cannot delete</h3>
            <ul className="list-disc space-y-0.5 pl-4 text-[12px] text-ink-2">
              {r.blockers.map((b) => <li key={b}>{b}</li>)}
            </ul>
            <p className="mt-2 text-[11px] text-ink-3">
              Approval policy: {r.policy.requiredApprovers ?? "NOT CONFIGURED"} approver(s) · approval valid {r.policy.approvalValidityMinutes ?? "NOT CONFIGURED"} min ·
              authorization valid {r.policy.authorizationValidityMinutes ?? "NOT CONFIGURED"} min · window {r.policy.deletionWindow ?? "NOT CONFIGURED"}
            </p>
          </div>
        </div>

        <ApprovalControls review={r} session={session.data} onDone={() => review.reload()} />
      </div>
    </Card>
  );
}
