/**
 * Phase 3C production-readiness behaviour — SYNTHETIC LOCAL DATABASES ONLY.
 * Approval-policy values used here are TEST-ONLY and are not proposals for production.
 */
import type { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ArchiveStorageError, type ArchiveStorage } from "../../archive/storage";
import { LocalDirectoryStorage } from "../../archive/providers";
import {
  ApprovalRefusedError, authorizeDeletion, DuplicateApprovalError, evaluateApprovals, evidenceKey, loadDeletionEvidence, recordApprovalDecision, revokeAuthorization,
} from "../../approvals/approvals";
import { setKillSwitch, KillSwitchRefusedError } from "../../controlplane/killSwitch";
import { grantRole, revokeRole, upsertOperator } from "../../controlplane/operators";
import { loadSettings, registerApplication } from "../../controlplane/repository";
import { runReadOnlyDiscovery } from "../../discovery/readOnlyDiscovery";
import { collectApplication } from "../../health/collector";
import { cancelJob, createJob, PolicyNotReadyError } from "../../jobs/jobs";
import { CrashSignal } from "../../jobs/faults";
import { NotificationDispatcher, buildMessage } from "../../notifications/notifications";
import {
  APP_ID, appConfig, auditActions, client, configureTestApprovalPolicy, count, createEnv, createTestOperators, enableAttendanceGroup, NOW, runner, secrets, testConfig, type Env,
} from "./harness";

let env: Env;
const DELETE_ON = testConfig({ allowDeletion: true, deletionAllowedEnvironments: ["synthetic"] });
const job = async (id: string) => (await env.cp.query(`SELECT * FROM control.archive_jobs WHERE id = $1`, [id])).rows[0];
const total = () => count(env.app, `SELECT (SELECT count(*) FROM public.attendance) + (SELECT count(*) FROM public.attendance_notes) AS n`);
const rejects = async (sql: string, params: unknown[] = []) => env.cp.query(sql, params).then(() => null, (e) => e as { code: string; message: string });

beforeAll(async () => {
  env = await createEnv("p3c_ready");
  await collectApplication(env.cp, secrets, APP_ID, { now: NOW });
  await enableAttendanceGroup(env.cp, { target: 400 });
  await createTestOperators(env.cp);
});
afterAll(async () => { await env?.close(); });

async function verifiedJob(id: string, mode: "ARCHIVE_VERIFY_DELETE" | "ARCHIVE_AND_VERIFY_ONLY" = "ARCHIVE_VERIFY_DELETE") {
  await createJob(env.cp, { id, applicationId: APP_ID, groupRoot: "public.attendance", createdBy: "operator-d", mode, now: NOW });
  expect((await runner(env).run(id)).status).toBe("ready_for_deletion");
  return evidenceKey((await loadDeletionEvidence(env.cp, id))!);
}

describe("control-plane migration 0002 (constraints that keep the safety states)", () => {
  it("adds operators, approvals, authorizations and disabled scheduling/notification tables with NULL approval policy", async () => {
    const s = await loadSettings(env.cp);
    expect(s.approvalPolicy).toEqual({ requiredApprovers: null, approvalValidityMinutes: null, excludesJobCreator: null, authorizationValidityMinutes: null, deletionWindow: null });
    expect(s.deletionKillSwitch).toBe(true);
  });
  it("a production application can never have the archive capability in Phase 3C", async () => {
    const e = await rejects(`INSERT INTO control.applications (id, name, environment, time_zone, archive_enabled) VALUES ('prod-x', 'P', 'production', NULL, true)`);
    expect(e?.message).toMatch(/production_is_read_only/);
  });
  it("schedules cannot be enabled and notifications cannot be marked sent", async () => {
    expect((await rejects(`INSERT INTO control.archive_schedules (application_id, group_root, enabled) VALUES ($1, 'public.attendance', true)`, [APP_ID]))?.code).toBe("23514");
    expect((await rejects(`INSERT INTO control.notification_outbox (event_type, channel, payload, status, reason) VALUES ('failure', 'email', '{}', 'sent', 'x')`))?.code).toBe("23514");
  });
  it("the notification dispatcher records suppressed notifications only", async () => {
    const reasons = await new NotificationDispatcher(env.cp).dispatch(buildMessage("threshold_alert", APP_ID, { table: "public.attendance", level: "LOW" }));
    expect(reasons.every((r) => /NOTIFICATIONS DISABLED/.test(r))).toBe(true);
    expect((await env.cp.query(`SELECT DISTINCT status FROM control.notification_outbox`)).rows).toEqual([{ status: "suppressed" }]);
  });
});

describe("missing configuration fails safely", () => {
  it("no application time zone → growth INSUFFICIENT HISTORY, preview blocked, job refused", async () => {
    await env.cp.query(`UPDATE control.applications SET time_zone = NULL WHERE id = $1`, [APP_ID]);
    try {
      await collectApplication(env.cp, secrets, APP_ID, { now: NOW });
      const g = (await env.cp.query(`SELECT growth FROM control.discovered_tables WHERE application_id = $1 AND table_name = 'attendance'`, [APP_ID])).rows[0].growth;
      expect(g).toMatchObject({ status: "insufficient_history", reason: "CANNOT RUN — APPLICATION TIMEZONE NOT CONFIGURED" });
      const p = (await env.cp.query(`SELECT status, preview FROM control.candidate_previews WHERE group_root = 'public.attendance'`)).rows[0];
      expect(p.status).toBe("blocked");
      expect(p.preview.blocking).toContain("CANNOT RUN — APPLICATION TIMEZONE NOT CONFIGURED");
      const e = await createJob(env.cp, { id: "J-NOTZ", applicationId: APP_ID, groupRoot: "public.attendance", createdBy: "t", now: NOW }).catch((x) => x);
      expect(e).toBeInstanceOf(PolicyNotReadyError);
      expect(e.codes).toContain("APPLICATION_TIMEZONE_NOT_CONFIGURED");
    } finally {
      await env.cp.query(`UPDATE control.applications SET time_zone = 'Asia/Kolkata' WHERE id = $1`, [APP_ID]);
    }
  });
  it("an enabled ARCHIVE root without a date column cannot even be stored", async () => {
    const e = await rejects(`UPDATE control.retention_policies SET date_column = NULL WHERE application_id = $1 AND table_name = 'attendance'`, [APP_ID]);
    expect(e?.message).toMatch(/enabled_archive_is_complete/);
  });
  it("a missing monitor secret → collection 'not_configured', audited, never retried", async () => {
    await env.cp.query(`UPDATE control.application_connections SET password_secret_ref = 'env:NOT_SET_ANYWHERE' WHERE application_id = $1 AND purpose = 'monitor'`, [APP_ID]);
    try {
      const r = await collectApplication(env.cp, secrets, APP_ID, { now: NOW });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/^configuration: cannot resolve DATABASE_CONNECTION secret env:NOT_SET_ANYWHERE: secret is not set/);
      expect((await env.cp.query(`SELECT connection_status FROM control.applications WHERE id = $1`, [APP_ID])).rows[0].connection_status).toBe("not_configured");
    } finally {
      await env.cp.query(`UPDATE control.application_connections SET password_secret_ref = 'env:SYNTH_MONITOR_PASSWORD' WHERE application_id = $1 AND purpose = 'monitor'`, [APP_ID]);
    }
  });
  it("a missing archive secret → job failed as a configuration block (no retry loop, 0 deleted)", async () => {
    await env.cp.query(`UPDATE control.application_connections SET password_secret_ref = 'env:NOT_SET_ANYWHERE' WHERE application_id = $1 AND purpose = 'archive'`, [APP_ID]);
    try {
      await createJob(env.cp, { id: "J-NOSECRET", applicationId: APP_ID, groupRoot: "public.attendance", createdBy: "t", now: NOW });
      expect((await runner(env).run("J-NOSECRET")).status).toBe("failed");
      const j = await job("J-NOSECRET");
      expect(j.retry_count).toBe(0);
      expect(j.failure).toMatchObject({ kind: "configuration" });
      expect((await auditActions(env.cp, "J-NOSECRET")).some((a) => a.action === "readiness_blocked" && a.result === "blocked")).toBe(true);
    } finally {
      await env.cp.query(`UPDATE control.application_connections SET password_secret_ref = 'env:SYNTH_ARCHIVE_PASSWORD' WHERE application_id = $1 AND purpose = 'archive'`, [APP_ID]);
    }
  });
  it("no archive provider → ARCHIVE EXECUTION UNAVAILABLE before touching the application", async () => {
    await createJob(env.cp, { id: "J-NOSTORE", applicationId: APP_ID, groupRoot: "public.attendance", createdBy: "t", now: NOW });
    expect((await runner(env, { store: null }).run("J-NOSTORE")).status).toBe("failed");
    const j = await job("J-NOSTORE");
    expect(j.failure.message).toMatch(/^ARCHIVE EXECUTION UNAVAILABLE/);
    expect(j.schema_hash).toBeNull(); // planning never ran
  });
  it("the local test destination is refused for a non-synthetic application", async () => {
    await env.cp.query(`UPDATE control.applications SET environment = 'staging' WHERE id = $1`, [APP_ID]);
    try {
      await createJob(env.cp, { id: "J-STAGING", applicationId: APP_ID, groupRoot: "public.attendance", createdBy: "t", now: NOW });
      expect((await runner(env).run("J-STAGING")).status).toBe("failed");
      expect((await job("J-STAGING")).failure.message).toMatch(/ARCHIVE EXECUTION UNAVAILABLE: local-directory is not approved for 'staging'/);
    } finally {
      await env.cp.query(`UPDATE control.applications SET environment = 'synthetic' WHERE id = $1`, [APP_ID]);
    }
  });
});

/** Delegating storage that fails the Nth upload, like a provider outage. */
class FlakyStorage implements ArchiveStorage {
  calls = 0;
  constructor(private inner: LocalDirectoryStorage, private failAt: number) {}
  get provider() { return this.inner.provider; }
  get description() { return "flaky test storage"; }
  get capabilities() { return this.inner.capabilities; }
  get approvedEnvironments() { return this.inner.approvedEnvironments; }
  async upload(key: string, body: Readable) {
    if (++this.calls === this.failAt) { body.resume(); throw new ArchiveStorageError("upload", key, new Error("503 Slow Down (simulated provider failure)")); }
    return this.inner.upload(key, body);
  }
  read(k: string) { return this.inner.read(k); }
  exists(k: string) { return this.inner.exists(k); }
  metadata(k: string) { return this.inner.metadata(k); }
  checksum(k: string) { return this.inner.checksum(k); }
  versions(k: string) { return this.inner.versions(k); }
  discardSupersededAttempt(p: string) { return this.inner.discardSupersededAttempt(p); }
  purge(p: string, a: Parameters<ArchiveStorage["purge"]>[1]) { return this.inner.purge(p, a); }
  uri(k: string) { return this.inner.uri(k); }
}

describe("archive provider failure and invalid checksums", () => {
  it("a provider failure during export → waiting_retry (storage), then a clean new attempt verifies", async () => {
    await createJob(env.cp, { id: "J-FLAKY", applicationId: APP_ID, groupRoot: "public.attendance", createdBy: "t", now: NOW });
    const out = await runner(env, { store: new FlakyStorage(env.store as LocalDirectoryStorage, 2) }).run("J-FLAKY");
    expect(out.status).toBe("waiting_retry");
    expect((await job("J-FLAKY")).failure).toMatchObject({ kind: "storage" });
    await env.cp.query(`UPDATE control.archive_jobs SET next_retry_at = now() - interval '1 second' WHERE id = 'J-FLAKY'`);
    expect((await runner(env).run("J-FLAKY")).status).toBe("ready_for_deletion");
    expect((await job("J-FLAKY")).attempt).toBe(2);
    await cancelJob(env.cp, "J-FLAKY", "t", "done");
  });
  it("an object whose checksum differs from the control-plane record fails verification (0 deleted)", async () => {
    await createJob(env.cp, { id: "J-SUM", applicationId: APP_ID, groupRoot: "public.attendance", createdBy: "t", now: NOW });
    await expect(runner(env, { faults: { at: "after_manifest_checkpoint" } }).run("J-SUM")).rejects.toBeInstanceOf(CrashSignal);
    await env.cp.query(`DELETE FROM control.worker_leases`);
    const m = (await env.cp.query(`SELECT files FROM control.archive_manifests WHERE job_id = 'J-SUM'`)).rows[0].files as Record<string, { sha256: string }>;
    const key = Object.keys(m).find((k) => k.includes("/data/"))!;
    m[key]!.sha256 = "0".repeat(64);
    await env.cp.query(`UPDATE control.archive_manifests SET files = $1 WHERE job_id = 'J-SUM'`, [JSON.stringify(m)]);
    const before = await total();
    expect((await runner(env).run("J-SUM")).status).toBe("failed");
    expect((await env.cp.query(`SELECT failed_stage FROM control.archive_verifications WHERE job_id = 'J-SUM'`)).rows[0].failed_stage).toBe("archive_integrity");
    expect(await total()).toBe(before);
  });
});

describe("approval workflow", () => {
  it("DELETION NOT AUTHORIZED while the approval policy is undecided", async () => {
    const ack = await verifiedJob("A-1");
    const e = await recordApprovalDecision(env.cp, { jobId: "A-1", operatorId: "approver-a", decision: "approve", evidenceAck: ack }).catch((x) => x);
    expect(e).toBeInstanceOf(ApprovalRefusedError);
    expect(e.message).toMatch(/DELETION NOT AUTHORIZED.*APPROVAL POLICY NOT CONFIGURED/);
    await configureTestApprovalPolicy(env.cp);
  });

  it("refuses the wrong role, the job creator, and stale evidence", async () => {
    const ack = evidenceKey((await loadDeletionEvidence(env.cp, "A-1"))!);
    const reasons = async (operatorId: string, a = ack) =>
      (await recordApprovalDecision(env.cp, { jobId: "A-1", operatorId, decision: "approve", evidenceAck: a }).catch((x) => x)).reasons.join("\n");
    expect(await reasons("viewer-e")).toMatch(/does not hold the APPROVER role/);
    expect(await reasons("admin-c")).toMatch(/does not hold the APPROVER role/);
    await grantRole(env.cp, "operator-d", "APPROVER", "test");
    expect(await reasons("operator-d")).toMatch(/job creator may not approve/);
    await revokeRole(env.cp, "operator-d", "APPROVER", "test");
    expect(await reasons("approver-a", { ...ack, attempt: 99 })).toMatch(/not the current evidence/);
    expect(await reasons("approver-a", { ...ack, manifestSha256: "tampered" })).toMatch(/not the current evidence/);
  });

  it("records one decision per approver; a duplicate is refused", async () => {
    const ack = evidenceKey((await loadDeletionEvidence(env.cp, "A-1"))!);
    const rec = await recordApprovalDecision(env.cp, { jobId: "A-1", operatorId: "approver-a", decision: "approve", evidenceAck: ack, comment: "reviewed evidence" });
    expect(rec).toMatchObject({ decision: "approve", counts: true });
    await expect(recordApprovalDecision(env.cp, { jobId: "A-1", operatorId: "approver-a", decision: "approve", evidenceAck: ack })).rejects.toBeInstanceOf(DuplicateApprovalError);
  });

  it("concurrent identical approvals from two sessions: exactly one is recorded", async () => {
    const ack = evidenceKey((await loadDeletionEvidence(env.cp, "A-1"))!);
    const [c1, c2] = [await client("p3c_ready_cp"), await client("p3c_ready_cp")];
    try {
      const results = await Promise.allSettled([c1, c2].map((c) => recordApprovalDecision(c, { jobId: "A-1", operatorId: "approver-b", decision: "approve", evidenceAck: ack })));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toBeInstanceOf(DuplicateApprovalError);
    } finally { await c1.end(); await c2.end(); }
    expect(await count(env.cp, `SELECT count(*) n FROM control.deletion_approvals WHERE job_id = 'A-1' AND operator_id = 'approver-b'`)).toBe(1);
  });

  it("authorization: ADMIN only, typed confirmation, and never by one of the approvers", async () => {
    const ack = evidenceKey((await loadDeletionEvidence(env.cp, "A-1"))!);
    await upsertOperator(env.cp, { id: "admin-approver-f", email: "f@synthetic.invalid" }, "test");
    await grantRole(env.cp, "admin-approver-f", "ADMIN", "test");
    await grantRole(env.cp, "admin-approver-f", "APPROVER", "test");
    await recordApprovalDecision(env.cp, { jobId: "A-1", operatorId: "admin-approver-f", decision: "approve", evidenceAck: ack });
    const why = async (operatorId: string, confirm = "A-1") => (await authorizeDeletion(env.cp, { jobId: "A-1", operatorId, evidenceAck: ack, confirmJobId: confirm }).catch((x) => x)).reasons?.join("\n");
    expect(await why("approver-a")).toMatch(/does not hold the ADMIN role/);
    expect(await why("admin-approver-f")).toMatch(/separation of duties/);
    expect(await why("admin-c", "A-2")).toMatch(/typed confirmation/);
    const auth = await authorizeDeletion(env.cp, { jobId: "A-1", operatorId: "admin-c", evidenceAck: ack, confirmJobId: "A-1" });
    expect(auth.operatorId).toBe("admin-c");
    expect((await job("A-1")).status).toBe("deletion_approved");
    expect(await why("admin-c")).toMatch(/requires ready_for_deletion|live authorization already exists/);
  });

  it("a fully approved and authorized job is STILL refused by the worker with the shipped config (ALLOW_DELETION=false)", async () => {
    await setKillSwitch(env.cp, { engaged: false, operatorId: "admin-c", reason: "test: prove ALLOW_DELETION alone blocks" });
    const before = await total();
    const out = await runner(env).run("A-1");
    await setKillSwitch(env.cp, { engaged: true, operatorId: "operator-d", reason: "test done" });
    expect(out.deletionBlocked).toEqual(["ALLOW_DELETION=false (deletion is disabled in this deployment)"]);
    expect(await total()).toBe(before);
    expect((await job("A-1")).status).toBe("deletion_approved");
  });

  it("approvals expire; an expired approval does not count toward the quorum", async () => {
    await cancelJob(env.cp, "A-1", "t", "next");
    const ack = await verifiedJob("A-EXP");
    const past = new Date(Date.now() - 2 * 3600_000); // test policy: approvals valid 60 min
    await recordApprovalDecision(env.cp, { jobId: "A-EXP", operatorId: "approver-a", decision: "approve", evidenceAck: ack, now: past });
    await recordApprovalDecision(env.cp, { jobId: "A-EXP", operatorId: "approver-b", decision: "approve", evidenceAck: ack });
    const ev = (await loadDeletionEvidence(env.cp, "A-EXP"))!;
    const { records, valid } = await evaluateApprovals(env.cp, ev, await loadSettings(env.cp), new Date());
    expect(records.find((r) => r.operatorId === "approver-a")).toMatchObject({ counts: false, notCountingReason: "expired" });
    expect(valid).toHaveLength(1);
    const e = await authorizeDeletion(env.cp, { jobId: "A-EXP", operatorId: "admin-c", evidenceAck: ack, confirmJobId: "A-EXP" }).catch((x) => x);
    expect(e.reasons.join()).toMatch(/approval quorum not met \(1 of 2/);
    await cancelJob(env.cp, "A-EXP", "t", "next");
  });

  it("a rejection blocks authorization", async () => {
    const ack = await verifiedJob("A-REJ");
    await recordApprovalDecision(env.cp, { jobId: "A-REJ", operatorId: "approver-a", decision: "reject", evidenceAck: ack, comment: "boundary looks wrong" });
    const e = await authorizeDeletion(env.cp, { jobId: "A-REJ", operatorId: "admin-c", evidenceAck: ack, confirmJobId: "A-REJ" }).catch((x) => x);
    expect(e.reasons.join()).toMatch(/an approver rejected this deletion/);
    await cancelJob(env.cp, "A-REJ", "t", "next");
  });

  it("concurrent authorizations by two ADMINs: exactly one succeeds", async () => {
    const ack = await verifiedJob("A-RACE");
    await recordApprovalDecision(env.cp, { jobId: "A-RACE", operatorId: "approver-a", decision: "approve", evidenceAck: ack });
    await recordApprovalDecision(env.cp, { jobId: "A-RACE", operatorId: "approver-b", decision: "approve", evidenceAck: ack });
    await upsertOperator(env.cp, { id: "admin-g", email: "g@synthetic.invalid" }, "test");
    await grantRole(env.cp, "admin-g", "ADMIN", "test");
    const [c1, c2] = [await client("p3c_ready_cp"), await client("p3c_ready_cp")];
    try {
      const results = await Promise.allSettled([
        authorizeDeletion(c1, { jobId: "A-RACE", operatorId: "admin-c", evidenceAck: ack, confirmJobId: "A-RACE" }),
        authorizeDeletion(c2, { jobId: "A-RACE", operatorId: "admin-g", evidenceAck: ack, confirmJobId: "A-RACE" }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    } finally { await c1.end(); await c2.end(); }
    expect(await count(env.cp, `SELECT count(*) n FROM control.deletion_authorizations WHERE job_id = 'A-RACE' AND revoked_at IS NULL`)).toBe(1);
  });

  it("worker re-validates: an expired authorization is refused at execution (synthetic, deletion engine enabled in test config)", async () => {
    await revokeAuthorization(env.cp, "A-RACE", "admin-c", "test re-authorize with an old timestamp");
    const ack = evidenceKey((await loadDeletionEvidence(env.cp, "A-RACE"))!);
    // revocation also revoked the approvals; clear them so fresh ones can be recorded (throwaway test control plane)
    await env.cp.query(`DELETE FROM control.deletion_approvals WHERE job_id = 'A-RACE'`);
    await recordApprovalDecision(env.cp, { jobId: "A-RACE", operatorId: "approver-a", decision: "approve", evidenceAck: ack });
    await recordApprovalDecision(env.cp, { jobId: "A-RACE", operatorId: "approver-b", decision: "approve", evidenceAck: ack });
    await authorizeDeletion(env.cp, { jobId: "A-RACE", operatorId: "admin-c", evidenceAck: ack, confirmJobId: "A-RACE", now: new Date(Date.now() - 45 * 60_000) }); // valid 30 min → expired
    await setKillSwitch(env.cp, { engaged: false, operatorId: "admin-c", reason: "synthetic test" });
    const before = await total();
    const out = await runner(env, { config: DELETE_ON }).run("A-RACE");
    await setKillSwitch(env.cp, { engaged: true, operatorId: "admin-c", reason: "synthetic test done" });
    expect(out.deletionBlocked!.join()).toMatch(/DELETION NOT AUTHORIZED: authorization has expired/);
    expect(await total()).toBe(before);
  });

  it("worker re-validates: outside the deletion window is refused", async () => {
    await configureTestApprovalPolicy(env.cp, { windowOpen: false });
    await setKillSwitch(env.cp, { engaged: false, operatorId: "admin-c", reason: "synthetic test" });
    const out = await runner(env, { config: DELETE_ON }).run("A-RACE");
    await setKillSwitch(env.cp, { engaged: true, operatorId: "admin-c", reason: "synthetic test done" });
    await configureTestApprovalPolicy(env.cp);
    expect(out.deletionBlocked!.join()).toMatch(/outside the deletion window/);
    await cancelJob(env.cp, "A-RACE", "t", "next");
  });

  it("worker re-validates per batch: revoking the authorization mid-deletion halts it (synthetic)", async () => {
    await env.cp.query(`UPDATE control.system_settings SET deletion_batch_size = 100`);
    const ack = await verifiedJob("A-REVOKE");
    await recordApprovalDecision(env.cp, { jobId: "A-REVOKE", operatorId: "approver-a", decision: "approve", evidenceAck: ack });
    await recordApprovalDecision(env.cp, { jobId: "A-REVOKE", operatorId: "approver-b", decision: "approve", evidenceAck: ack });
    await authorizeDeletion(env.cp, { jobId: "A-REVOKE", operatorId: "admin-c", evidenceAck: ack, confirmJobId: "A-REVOKE" });
    await setKillSwitch(env.cp, { engaged: false, operatorId: "admin-c", reason: "synthetic test" });
    const out = await runner(env, { config: DELETE_ON, hooks: { afterDeletionBatch: async (i) => { if (i === 0) await revokeAuthorization(env.cp, "A-REVOKE", "admin-c", "stop"); } } }).run("A-REVOKE");
    await setKillSwitch(env.cp, { engaged: true, operatorId: "admin-c", reason: "synthetic test done" });
    await env.cp.query(`UPDATE control.system_settings SET deletion_batch_size = 2000`);
    expect(out.status).toBe("requires_review");
    expect(out.deletionBlocked!.join()).toMatch(/no live authorization/);
    expect(await count(env.cp, `SELECT count(*) n FROM control.archive_deletion_batches WHERE job_id = 'A-REVOKE' AND state = 'done'`)).toBe(1);
  });
});

describe("kill switch authority", () => {
  it("VIEWER cannot change it; OPERATOR can engage but not release; ADMIN can release", async () => {
    await expect(setKillSwitch(env.cp, { engaged: true, operatorId: "viewer-e", reason: "x" })).rejects.toBeInstanceOf(KillSwitchRefusedError);
    await setKillSwitch(env.cp, { engaged: true, operatorId: "operator-d", reason: "incident drill" });
    await expect(setKillSwitch(env.cp, { engaged: false, operatorId: "operator-d", reason: "x" })).rejects.toBeInstanceOf(KillSwitchRefusedError);
    await expect(setKillSwitch(env.cp, { engaged: false, operatorId: "approver-a", reason: "x" })).rejects.toBeInstanceOf(KillSwitchRefusedError);
    expect(await setKillSwitch(env.cp, { engaged: false, operatorId: "admin-c", reason: "drill over" })).toEqual({ engaged: false, changed: true });
    await setKillSwitch(env.cp, { engaged: true, operatorId: "admin-c", reason: "restore default" });
    expect((await loadSettings(env.cp)).killSwitchChangedBy).toBe("admin-c");
  });
  it("concurrent engage requests are both audited; the state ends ENGAGED", async () => {
    await setKillSwitch(env.cp, { engaged: false, operatorId: "admin-c", reason: "prepare race" });
    const [c1, c2] = [await client("p3c_ready_cp"), await client("p3c_ready_cp")];
    try {
      const r = await Promise.all([
        setKillSwitch(c1, { engaged: true, operatorId: "operator-d", reason: "race 1" }),
        setKillSwitch(c2, { engaged: true, operatorId: "approver-a", reason: "race 2" }),
      ]);
      expect(r.filter((x) => x.changed)).toHaveLength(1);
    } finally { await c1.end(); await c2.end(); }
    expect((await loadSettings(env.cp)).deletionKillSwitch).toBe(true);
  });
});

describe("read-only discovery (first production connection procedure) — synthetic", () => {
  it("refuses an application that has the archive capability", async () => {
    await expect(runReadOnlyDiscovery(env.cp, secrets, APP_ID, { now: NOW })).rejects.toThrow(/requires archive capability OFF/);
  });
  it("produces the discovery report; every table REVIEW_REQUIRED; monitor role holds no write privilege", async () => {
    const cfg = appConfig("p3c_ready", { id: "synthetic-readonly", name: "Synthetic read-only", capabilities: { monitoring: true, archive: false } });
    delete cfg.connections.archive;
    await registerApplication(env.cp, cfg);
    const r = await runReadOnlyDiscovery(env.cp, secrets, "synthetic-readonly", { now: NOW });
    expect(r.sessionReadOnly).toBe(true);
    expect(r.writePrivileges).toEqual([]);
    for (const section of ["## Tables", "## Foreign keys", "## Growth history availability", "## RLS findings", "## Candidate archive tables (HEURISTIC", "## Tables that should remain protected", "## Configuration gaps"]) {
      expect(r.report).toContain(section);
    }
    expect(r.report).toContain("`public.attendance_notes` → `public.attendance`");
    expect(r.report).toMatch(/public\.private_sessions`: RLS enabled — \*\*the connected role cannot bypass RLS/);
    const policies = (await env.cp.query(`SELECT DISTINCT policy FROM control.retention_policies WHERE application_id = 'synthetic-readonly'`)).rows;
    expect(policies).toEqual([{ policy: "REVIEW_REQUIRED" }]);
    expect(r.report).not.toMatch(/synthetic member \d|synthetic note \d/); // no row contents
  });
  it("warns when the monitor role could write (the session stays read-only)", async () => {
    await env.cp.query(`UPDATE control.application_connections SET username = 'postgres', password_secret_ref = 'env:SYNTH_ADMIN_PASSWORD' WHERE application_id = 'synthetic-readonly'`);
    const s2 = new (await import("../../connection/secrets")).EnvSecretResolver({ SYNTH_ADMIN_PASSWORD: "prototype-local-only" });
    const r = await runReadOnlyDiscovery(env.cp, s2, "synthetic-readonly", { now: NOW });
    expect(r.sessionReadOnly).toBe(true);
    expect(r.writePrivileges.length).toBeGreaterThan(0);
    expect(r.report).toContain("**WARNING:** the role could write");
  });
});
