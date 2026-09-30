/**
 * Deletion-engine safety — SYNTHETIC LOCAL DATABASE ONLY.
 *
 * The engine is exercised here with a TEST-ONLY config (allowDeletion=true, environment "synthetic",
 * kill switch turned off in the throwaway control plane) to prove its guards. The shipped defaults
 * (ALLOW_DELETION=false, kill switch ON) refuse every deletion — see the first tests.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectApplication } from "../../health/collector";
import { upsertPolicy } from "../../controlplane/repository";
import { approveDeletion, cancelJob, createJob } from "../../jobs/jobs";
import { loadCandidates } from "../../jobs/candidates";
import { CrashSignal, type CrashPoint } from "../../jobs/faults";
import { LeaseHeldError } from "../../recovery/lease";
import { defaultPolicy } from "../../retention/policy";
import { APP_ID, auditActions, count, createEnv, enableAttendanceGroup, NOW, runner, secrets, testConfig, type Env } from "./harness";

let env: Env;
const DELETE_ON = testConfig({ allowDeletion: true, deletionAllowedEnvironments: ["synthetic"] });
const total = () => count(env.app, `SELECT (SELECT count(*) FROM public.attendance) + (SELECT count(*) FROM public.attendance_notes) AS n`);
const job = async (id: string) => (await env.cp.query(`SELECT * FROM control.archive_jobs WHERE id = $1`, [id])).rows[0];
const killSwitch = (on: boolean) => env.cp.query(`UPDATE control.system_settings SET deletion_kill_switch = $1`, [on]);
const expireLeases = () => env.cp.query(`UPDATE control.worker_leases SET expires_at = now() - interval '1 second'`);

beforeAll(async () => {
  env = await createEnv("p3b_delete");
  await collectApplication(env.cp, secrets, APP_ID, { now: NOW });
  await enableAttendanceGroup(env.cp, { target: 1000 });
});
afterAll(async () => { await env?.close(); });

/** Create a job with mode ARCHIVE_VERIFY_DELETE, archive + verify it, and approve it. */
async function approvedJob(id: string) {
  await createJob(env.cp, { id, applicationId: APP_ID, groupRoot: "public.attendance", createdBy: "test", mode: "ARCHIVE_VERIFY_DELETE", now: NOW });
  expect((await runner(env).run(id)).status).toBe("ready_for_deletion");
  await approveDeletion(env.cp, id, "test:operator");
}

describe("deletion is refused by every independent safety layer", () => {
  it("shipped defaults (ALLOW_DELETION unset, kill switch ON) refuse an approved, verified job", async () => {
    await approvedJob("D-DEFAULT");
    const before = await total();
    const out = await runner(env).run("D-DEFAULT");
    expect(out.status).toBe("deletion_approved");
    expect(out.deletionBlocked!.join("\n")).toMatch(/ALLOW_DELETION=false/);
    expect(out.deletionBlocked!.join("\n")).toMatch(/kill switch is ON/);
    expect(await total()).toBe(before);
  });

  it("kill switch ON blocks even with ALLOW_DELETION=true", async () => {
    const before = await total();
    const out = await runner(env, { config: DELETE_ON }).run("D-DEFAULT");
    expect(out.deletionBlocked).toEqual(["deletion kill switch is ON"]);
    expect(await total()).toBe(before);
  });

  it("a non-synthetic application environment blocks deletion", async () => {
    await killSwitch(false);
    await env.cp.query(`UPDATE control.applications SET environment = 'staging' WHERE id = $1`, [APP_ID]);
    try {
      const before = await total();
      const out = await runner(env, { config: DELETE_ON }).run("D-DEFAULT");
      expect(out.deletionBlocked!.join()).toMatch(/environment 'staging' is not in DELETION_ALLOWED_ENVIRONMENTS/);
      expect(await total()).toBe(before);
    } finally {
      await env.cp.query(`UPDATE control.applications SET environment = 'synthetic' WHERE id = $1`, [APP_ID]);
      await killSwitch(true);
    }
    const blocked = (await auditActions(env.cp, "D-DEFAULT")).filter((a) => a.action === "deletion_blocked");
    expect(blocked).toHaveLength(3);
    expect(blocked.every((b) => b.result === "blocked" && (b.detail as { deleted: number }).deleted === 0)).toBe(true);
  });

  it("schema mismatch before deletion → requires_review, 0 deleted", async () => {
    await killSwitch(false);
    const before = await total();
    const out = await runner(env, {
      config: DELETE_ON,
      hooks: { beforeDeletionGate: async (src) => { void src; await env.app.query(`ALTER TABLE public.attendance_notes ADD COLUMN mood text`); } },
    }).run("D-DEFAULT");
    await env.app.query(`ALTER TABLE public.attendance_notes DROP COLUMN mood`);
    await killSwitch(true);
    expect(out.status).toBe("requires_review");
    expect(out.deletionBlocked!.join()).toMatch(/schema hash changed/);
    expect(await total()).toBe(before);
    expect((await job("D-DEFAULT")).failure.deleted).toBe(0);
  });
});

describe("deletion engine on synthetic data (test-only enablement)", () => {
  it("deletes exactly the frozen, unchanged, unreferenced keys; edited and newly referenced rows are skipped and reported", async () => {
    await approvedJob("D-EXACT");
    const { keys } = await loadCandidates(env.cp, "D-EXACT", 1);
    const roots = keys["public.attendance"]!.map((k) => k.pk);
    const withoutNotes = roots.filter((pk) => Number(pk) % 3 !== 0);
    const drifted = withoutNotes[0]!;
    const held = withoutNotes[1]!;
    const sel = (await job("D-EXACT")).selection;
    const before = await total();

    await killSwitch(false);
    const out = await runner(env, {
      config: DELETE_ON,
      hooks: {
        beforeDeletionGate: async () => {
          await env.app.query(`UPDATE public.attendance SET note = 'edited after freeze' WHERE id = $1`, [drifted]);
          await env.app.query(`INSERT INTO public.attendance_notes (id, attendance_id, body) VALUES (700001, $1, 'new child after freeze')`, [held]);
          await env.app.query(`INSERT INTO public.attendance (id, member_id, checked_in_at, note) VALUES (700002, 1, $1::date + time '09:00', 'backdated after freeze')`, [sel.oldestDate]);
        },
      },
    }).run("D-EXACT");
    await killSwitch(true);

    expect(out.status).toBe("completed_with_exceptions");
    const frozen = keys["public.attendance"]!.length + keys["public.attendance_notes"]!.length;
    // Exactly the frozen set minus the two skipped roots is gone; the 2 inserted rows remain.
    expect(await total()).toBe(before + 2 - (frozen - 2));
    expect(await count(env.app, `SELECT count(*) n FROM public.attendance WHERE id = ANY($1::bigint[])`, [[drifted, held, "700002"]])).toBe(3);
    expect(await count(env.app, `SELECT count(*) n FROM public.attendance_notes WHERE id = 700001`)).toBe(1);
    expect(await count(env.app, `SELECT count(*) n FROM public.attendance WHERE id = ANY($1::bigint[])`, [roots])).toBe(2);

    const tables = Object.fromEntries((await env.cp.query(`SELECT table_name, deleted, skipped, missing, reconciled FROM control.archive_job_tables WHERE job_id = 'D-EXACT'`)).rows.map((r) => [r.table_name, r]));
    expect(tables["public.attendance"]).toMatchObject({ deleted: roots.length - 2, skipped: 2, missing: 0, reconciled: true });
    expect(tables["public.attendance_notes"]).toMatchObject({ deleted: keys["public.attendance_notes"]!.length, skipped: 0, reconciled: true });

    const actions = await auditActions(env.cp, "D-EXACT");
    expect(actions.map((a) => a.action)).toEqual(expect.arrayContaining(["deletion_approved", "deletion_attempted", "deletion_batch_completed", "deletion_verified", "deletion_completed"]));
    const verified = actions.find((a) => a.action === "deletion_verified")!.detail as { maintenance: Record<string, string> };
    expect(Object.values(verified.maintenance)).toEqual(["vacuum_analyze_ok", "vacuum_analyze_ok"]); // VACUUM (ANALYZE), never VACUUM FULL
  });

  it("kill switch engaged mid-deletion halts at the next batch → requires_review", async () => {
    await env.cp.query(`UPDATE control.system_settings SET deletion_batch_size = 200`);
    await approvedJob("D-KILL");
    await killSwitch(false);
    const out = await runner(env, { config: DELETE_ON, hooks: { afterDeletionBatch: async (i) => { if (i === 0) await killSwitch(true); } } }).run("D-KILL");
    expect(out.status).toBe("requires_review");
    expect(out.deletionBlocked).toEqual(["deletion kill switch is ON"]);
    const batches = (await env.cp.query(`SELECT batch_no, state FROM control.archive_deletion_batches WHERE job_id = 'D-KILL' ORDER BY batch_no`)).rows;
    expect(batches).toEqual([{ batch_no: 0, state: "done" }]);
    await env.cp.query(`UPDATE control.system_settings SET deletion_batch_size = 2000`);
  });
});

describe("job recovery", () => {
  beforeAll(async () => { await enableAttendanceGroup(env.cp, { target: 400 }); }); // keep enough eligible synthetic days for every case
  it("resumes after a crash at every pre-deletion point; each re-export is a fresh attempt", async () => {
    await createJob(env.cp, { id: "R-PRE", applicationId: APP_ID, groupRoot: "public.attendance", createdBy: "test", now: NOW });
    const points: CrashPoint[] = ["before_freeze", "during_export", "after_export_before_checkpoint", "after_manifest_checkpoint", "during_verification"];
    for (const at of points) {
      await expect(runner(env, { faults: { at } }).run("R-PRE")).rejects.toBeInstanceOf(CrashSignal);
      // the crashed worker's lease is still held → another worker is refused until it expires
      await expect(runner(env, { config: testConfig({ workerId: "test-worker-b" }) }).run("R-PRE")).rejects.toBeInstanceOf(LeaseHeldError);
      await expireLeases();
    }
    const out = await runner(env, { config: testConfig({ workerId: "test-worker-b" }) }).run("R-PRE");
    expect(out.status).toBe("ready_for_deletion");
    const j = await job("R-PRE");
    expect(j.attempt).toBeGreaterThanOrEqual(3);
    expect(await count(env.cp, `SELECT count(DISTINCT attempt) n FROM control.archive_job_candidates WHERE job_id = 'R-PRE'`)).toBe(1);
    const v = (await env.cp.query(`SELECT verified, attempt FROM control.archive_verifications WHERE job_id = 'R-PRE' ORDER BY id DESC LIMIT 1`)).rows[0];
    expect(v).toEqual({ verified: true, attempt: j.attempt });
    expect((await auditActions(env.cp, "R-PRE")).some((a) => a.action === "lease_takeover")).toBe(true);
    await cancelJob(env.cp, "R-PRE", "test", "done");
  });

  it.each(["before_deletion", "mid_deletion_in_txn", "mid_deletion_after_commit", "after_deletion", "during_deletion_verification"] as CrashPoint[])(
    "resumes deletion idempotently after a crash at %s (nothing outside the frozen set is deleted)",
    async (at) => {
      await env.cp.query(`UPDATE control.system_settings SET deletion_batch_size = 150`);
      const id = `R-${at}`;
      await approvedJob(id);
      const { keys } = await loadCandidates(env.cp, id, 1);
      const frozen = keys["public.attendance"]!.length + keys["public.attendance_notes"]!.length;
      const before = await total();
      await killSwitch(false);
      try {
        await expect(runner(env, { config: DELETE_ON, faults: { at } }).run(id)).rejects.toBeInstanceOf(CrashSignal);
        await expireLeases();
        const out = await runner(env, { config: { ...DELETE_ON, workerId: "test-worker-b" } }).run(id);
        expect(out.status).toBe("completed");
      } finally {
        await killSwitch(true);
        await env.cp.query(`UPDATE control.system_settings SET deletion_batch_size = 2000`);
      }
      expect(await total()).toBe(before - frozen);
      const t = (await env.cp.query(`SELECT bool_and(reconciled) ok FROM control.archive_job_tables WHERE job_id = $1`, [id])).rows[0];
      expect(t.ok).toBe(true);
    },
  );

  it("a refused connection becomes waiting_retry with backoff, then resumes", async () => {
    await createJob(env.cp, { id: "R-CONN", applicationId: APP_ID, groupRoot: "public.attendance", createdBy: "test", now: NOW });
    await env.cp.query(`UPDATE control.application_connections SET port = 1 WHERE application_id = $1 AND purpose = 'archive'`, [APP_ID]);
    const out = await runner(env).run("R-CONN");
    expect(out.status).toBe("waiting_retry");
    const j = await job("R-CONN");
    expect(j).toMatchObject({ status: "waiting_retry", resume_status: "preparing", retry_count: 1 });
    expect(j.failure.kind).toBe("transient");
    expect((await auditActions(env.cp, "R-CONN")).some((a) => a.action === "job_retry_scheduled")).toBe(true);
    // not yet due → nothing happens
    expect((await runner(env).run("R-CONN")).status).toBe("waiting_retry");
    await env.cp.query(`UPDATE control.application_connections SET port = $2 WHERE application_id = $1 AND purpose = 'archive'`, [APP_ID, env.appConfig.connections.archive!.port]);
    await env.cp.query(`UPDATE control.archive_jobs SET next_retry_at = now() - interval '1 second' WHERE id = 'R-CONN'`);
    expect((await runner(env).run("R-CONN")).status).toBe("ready_for_deletion");
    await cancelJob(env.cp, "R-CONN", "test", "done");
  });
});

describe("RLS preflight", () => {
  beforeAll(async () => {
    await upsertPolicy(env.cp, { ...defaultPolicy(APP_ID, "public", "private_sessions"), policy: "ARCHIVE", dateColumn: "started_at", protectedPeriodMonths: 6,
      targetRecords: 500, gracePeriodDays: 7, enabled: true, groupRoot: "public.private_sessions", updatedBy: "test:operator" });
  });

  it("blocks a table whose RLS would hide rows from the archive role", async () => {
    await createJob(env.cp, { id: "RLS-1", applicationId: APP_ID, groupRoot: "public.private_sessions", createdBy: "test", now: NOW });
    expect((await runner(env).run("RLS-1")).status).toBe("failed");
    const j = await job("RLS-1");
    expect(j.failure.blocking.join()).toMatch(/rls_hides_rows: public.private_sessions/);
    expect(j.failure.deleted).toBe(0);
  });

  it("proceeds when the archive role has BYPASSRLS and sees every row", async () => {
    await env.cp.query(`UPDATE control.application_connections SET username = 'p3b_archiver_bypass', password_secret_ref = 'env:SYNTH_ARCHIVE_BYPASS_PASSWORD' WHERE application_id = $1 AND purpose = 'archive'`, [APP_ID]);
    await createJob(env.cp, { id: "RLS-2", applicationId: APP_ID, groupRoot: "public.private_sessions", createdBy: "test", now: NOW });
    expect((await runner(env).run("RLS-2")).status).toBe("ready_for_deletion");
    const { keys } = await loadCandidates(env.cp, "RLS-2", 1);
    const members = await count(env.app, `SELECT count(DISTINCT member_id) n FROM public.private_sessions WHERE id = ANY($1::bigint[])`, [keys["public.private_sessions"]!.map((k) => k.pk)]);
    expect(members).toBe(5); // rows of every member, not just the ones the RLS policy exposes
  });
});
