/** Pure mapping of the worker's deletion-review data to the UI contract. No secrets, no row data. */
import type { DeletionReviewData } from "@/lib/domain/types";
import type { ApprovalRecord, AuthorizationRecord, DeletionEvidence } from "../../../worker/approvals/approvals";
import type { SystemSettingsRow } from "../../../worker/controlplane/repository";

const short = (t: string) => (t.startsWith("public.") ? t.slice(7) : t);

export function mapDeletionReview(ev: DeletionEvidence, approvals: ApprovalRecord[], auths: AuthorizationRecord[], s: SystemSettingsRow, gaps: string[]): DeletionReviewData {
  const blockers = ["PRODUCTION DELETION DISABLED (ALLOW_DELETION=false in every deployment)"];
  if (ev.mode !== "ARCHIVE_VERIFY_DELETE") blockers.push(`job mode ${ev.mode}: archive-and-verify only — never deletes`);
  if (gaps.length) blockers.push(`DELETION NOT AUTHORIZED — APPROVAL POLICY NOT CONFIGURED (${gaps.join(", ")})`);
  if (s.deletionKillSwitch) blockers.push("deletion kill switch is ENGAGED");
  if (!ev.verification?.verified) blockers.push("archive verification has not passed");
  const w = s.approvalPolicy.deletionWindow;
  return {
    jobId: ev.jobId,
    applicationId: ev.applicationId,
    applicationName: ev.applicationName,
    environment: ev.environment,
    mode: ev.mode,
    status: ev.status,
    tables: ev.tables.map(short),
    candidateCount: ev.candidateRows,
    rowsByTable: Object.fromEntries(Object.entries(ev.rowsByTable).map(([t, n]) => [short(t), n])),
    oldestDay: ev.oldestDay,
    boundaryDay: ev.boundaryDay,
    evidence: { attempt: ev.attempt, manifestSha256: ev.manifestSha256, schemaHash: ev.schemaHash, graphHash: ev.graphHash, candidateDigest: ev.candidateDigest },
    archiveLocation: ev.storeUri,
    archiveDataBytes: ev.archiveDataBytes,
    verification: ev.verification && { verified: ev.verification.verified, verifiedAt: ev.verification.verifiedAt, failedStage: ev.verification.failedStage,
      keySetPassed: ev.verification.keySetPassed, restoreFingerprintPassed: ev.verification.restoreFingerprintPassed, schemaHashPassed: ev.verification.schemaHashPassed },
    candidateSetIntact: ev.candidateSetIntact,
    impact: ev.impact.map((i) => ({ ...i, table: short(i.table) })),
    approvals: approvals.map((a) => ({ id: a.id, operator: a.email ?? a.operatorId, decision: a.decision, comment: a.comment, decidedAt: a.decidedAt, expiresAt: a.expiresAt,
      revokedAt: a.revokedAt, counts: a.counts, notCountingReason: a.notCountingReason })),
    authorizations: auths.map((a) => ({ id: a.id, operator: a.operatorId, authorizedAt: a.authorizedAt, expiresAt: a.expiresAt, revokedAt: a.revokedAt, consumedAt: a.consumedAt })),
    policy: {
      requiredApprovers: s.approvalPolicy.requiredApprovers,
      approvalValidityMinutes: s.approvalPolicy.approvalValidityMinutes,
      authorizationValidityMinutes: s.approvalPolicy.authorizationValidityMinutes,
      deletionWindow: w ? `${w.start.slice(0, 5)}–${w.end.slice(0, 5)} ${w.timeZone}` : null,
      gaps,
    },
    productionDeletion: "DISABLED",
    blockers,
  };
}
