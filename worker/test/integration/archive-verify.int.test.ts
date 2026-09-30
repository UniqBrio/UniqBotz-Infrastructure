import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectApplication } from "../../health/collector";
import { approveDeletion, cancelJob, createJob, DuplicateJobError, PolicyNotReadyError } from "../../jobs/jobs";
import { loadCandidates } from "../../jobs/candidates";
import { CrashSignal } from "../../jobs/faults";
import { fingerprintSql } from "../../schema/fingerprint";
import { APP_ID, auditActions, count, createEnv, enableAttendanceGroup, NOW, runner, secrets, type Env } from "./harness";

let env: Env;
const snapshot = () => count(env.app, `SELECT (SELECT count(*) FROM public.attendance) * 1000000 + (SELECT count(*) FROM public.attendance_notes) AS n`);
let initial: number;

beforeAll(async () => {
  env = await createEnv("p3b_archive");
  await collectApplication(env.cp, secrets, APP_ID, { now: NOW });
  initial = await snapshot();
});
afterAll(async () => { await env?.close(); });

const job = async (id: string) => (await env.cp.query(`SELECT * FROM control.archive_jobs WHERE id = $1`, [id])).rows[0];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
}

describe("retention policy loading → job creation", () => {
  it("refuses REVIEW_REQUIRED tables (never auto-archives an unknown table)", async () => {
    await expect(createJob(env.cp, { id: "J-NOPE", applicationId: APP_ID, groupRoot: "public.attendance", createdBy: "test", now: NOW })).rejects.toBeInstanceOf(PolicyNotReadyError);
  });

  it("refuses when no grace period is configured (no built-in default)", async () => {
    await enableAttendanceGroup(env.cp, { grace: null });
    await expect(createJob(env.cp, { id: "J-NOGRACE", applicationId: APP_ID, groupRoot: "public.attendance", createdBy: "test", now: NOW })).rejects.toThrow(/grace period/);
    await env.cp.query(`UPDATE control.system_settings SET default_grace_period_days = 7`);
    const spec = await createJob(env.cp, { id: "J-SYSGRACE", applicationId: APP_ID, groupRoot: "public.attendance", createdBy: "test", now: NOW });
    expect(spec.cutoffDay).toBe("2026-03-23"); // system default applied
    await cancelJob(env.cp, "J-SYSGRACE", "test", "cleanup");
    await env.cp.query(`UPDATE control.system_settings SET default_grace_period_days = NULL`);
  });

  it("builds the job spec from stored policies; defaults to ARCHIVE_AND_VERIFY_ONLY; rejects a duplicate active job", async () => {
    await enableAttendanceGroup(env.cp, { target: 3000, grace: 7 });
    const spec = await createJob(env.cp, { id: "J-1", applicationId: APP_ID, groupRoot: "public.attendance", createdBy: "test", now: NOW });
    expect(spec).toMatchObject({ root: "public.attendance", tables: ["public.attendance", "public.attendance_notes"], cutoffDay: "2026-03-23", target: 3000, timeZone: "Asia/Kolkata" });
    expect((await job("J-1")).mode).toBe("ARCHIVE_AND_VERIFY_ONLY");
    await expect(createJob(env.cp, { id: "J-DUP", applicationId: APP_ID, groupRoot: "public.attendance", createdBy: "test", now: NOW })).rejects.toBeInstanceOf(DuplicateJobError);
    expect((await auditActions(env.cp)).some((a) => a.action === "job_duplicate_rejected" && a.result === "blocked")).toBe(true);
  });
});

describe("ARCHIVE_AND_VERIFY_ONLY", () => {
  it("freezes, exports, fully verifies and stops at ready_for_deletion with 0 rows deleted", async () => {
    const out = await runner(env).run("J-1");
    expect(out.status).toBe("ready_for_deletion");
    const j = await job("J-1");
    expect(j.attempt).toBe(1);
    expect(j.selection.totalSelected).toBeGreaterThanOrEqual(3000);
    expect(j.selection.boundaryDate).toBe(j.selection.previewBoundary);

    const v = (await env.cp.query(`SELECT verified, failed_stage, checks FROM control.archive_verifications WHERE job_id = 'J-1'`)).rows;
    expect(v).toHaveLength(1);
    expect(v[0].verified).toBe(true);
    const stages = new Set(v[0].checks.map((c: { stage: string }) => c.stage));
    expect([...stages]).toEqual(["archive_created", "archive_integrity", "archive_row_count", "archive_key_set", "restore_fingerprint", "schema_hash"]);

    const { keys, intact } = await loadCandidates(env.cp, "J-1", 1);
    expect(intact).toBe(true);
    const frozen = keys["public.attendance"]!.length + keys["public.attendance_notes"]!.length;
    expect(frozen).toBe(j.selection.totalSelected);
    expect(await snapshot()).toBe(initial); // NOTHING deleted
    expect(await count(env.cp, `SELECT count(*) n FROM control.archive_deletion_batches`)).toBe(0);

    const actions = (await auditActions(env.cp, "J-1")).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["job_created", "candidates_frozen", "archive_created", "archive_verified"]));
    expect(actions).not.toContain("deletion_attempted");
  });

  it("freeze: frozen keys are exact PK + row fingerprint of whole days only; later backdated rows are not candidates", async () => {
    const j = await job("J-1");
    const { keys } = await loadCandidates(env.cp, "J-1", 1);
    const live = new Map((await env.app.query(
      `SELECT id::text pk, ${fingerprintSql("t")} fp, (t.checked_in_at AT TIME ZONE 'Asia/Kolkata')::date::text AS day FROM public.attendance t
       WHERE id = ANY($1::bigint[])`, [keys["public.attendance"]!.map((k) => k.pk)])).rows.map((r) => [r.pk, r]));
    expect(live.size).toBe(keys["public.attendance"]!.length);
    for (const k of keys["public.attendance"]!) expect(live.get(k.pk)!.fp).toBe(k.fp);
    const days = new Set([...live.values()].map((r) => r.day));
    expect([...days].sort().at(-1)).toBe(j.selection.boundaryDate);
    // A row for a frozen day that is every row of the boundary day is included (whole days).
    expect(await count(env.app, `SELECT count(*) n FROM public.attendance WHERE (checked_in_at AT TIME ZONE 'Asia/Kolkata')::date = $1`, [j.selection.boundaryDate]))
      .toBe([...live.values()].filter((r) => r.day === j.selection.boundaryDate).length);

    await env.app.query(`INSERT INTO public.attendance (id, member_id, checked_in_at, note) VALUES (800001, 1, $1::date + time '10:00', 'backdated after freeze')`, [j.selection.oldestDate]);
    const again = await loadCandidates(env.cp, "J-1", 1);
    expect(again.keys["public.attendance"]!.some((k) => k.pk === "800001")).toBe(false);
    await env.app.query(`DELETE FROM public.attendance WHERE id = 800001`);
  });

  it("approval is refused for a verify-only job and audited", async () => {
    await expect(approveDeletion(env.cp, "J-1", "operator")).rejects.toThrow(/cannot be approved/);
    expect((await job("J-1")).status).toBe("ready_for_deletion");
    const blocked = (await auditActions(env.cp, "J-1")).filter((a) => a.action === "deletion_blocked");
    expect(JSON.stringify(blocked.at(-1)!.detail)).toMatch(/ARCHIVE_AND_VERIFY_ONLY/);
  });

  it("deletion disabled: even a tampered job status cannot make the worker delete (ALLOW_DELETION=false)", async () => {
    await env.cp.query(`UPDATE control.system_settings SET deletion_kill_switch = false`);
    await env.cp.query(`UPDATE control.archive_jobs SET status = 'deletion_approved' WHERE id = 'J-1'`);
    const out = await runner(env).run("J-1");
    expect(out.deletionBlocked!.join("\n")).toMatch(/ALLOW_DELETION=false/);
    expect(out.deletionBlocked!.join("\n")).toMatch(/job mode is ARCHIVE_AND_VERIFY_ONLY/);
    expect(await snapshot()).toBe(initial);
    const last = (await auditActions(env.cp, "J-1")).filter((a) => a.action === "deletion_blocked").at(-1)!;
    expect(last.result).toBe("blocked");
    expect((last.detail as { deleted: number }).deleted).toBe(0);
    await env.cp.query(`UPDATE control.system_settings SET deletion_kill_switch = true`);
    await env.cp.query(`UPDATE control.archive_jobs SET status = 'ready_for_deletion' WHERE id = 'J-1'`);
    await cancelJob(env.cp, "J-1", "test", "next test");
  });
});

describe("verification failures → DELETE = 0", () => {
  async function exportOnly(id: string) {
    await createJob(env.cp, { id, applicationId: APP_ID, groupRoot: "public.attendance", createdBy: "test", now: NOW });
    await expect(runner(env, { faults: { at: "after_manifest_checkpoint" } }).run(id)).rejects.toBeInstanceOf(CrashSignal);
    await env.cp.query(`DELETE FROM control.worker_leases`); // the crashed worker's lease has "expired"
    expect((await job(id)).status).toBe("verifying");
  }

  it("a corrupted archive object fails archive_integrity", async () => {
    await exportOnly("J-CORRUPT");
    const data = files(env.storeDir).find((f) => f.includes("J-CORRUPT") && f.includes("/data/") && f.includes("attendance.csv"))!;
    const buf = readFileSync(data);
    buf[buf.length - 20] = buf[buf.length - 20]! ^ 0xff;
    writeFileSync(data, buf);
    expect((await runner(env).run("J-CORRUPT")).status).toBe("failed");
    const v = (await env.cp.query(`SELECT verified, failed_stage FROM control.archive_verifications WHERE job_id = 'J-CORRUPT'`)).rows[0];
    expect(v).toEqual({ verified: false, failed_stage: "archive_integrity" });
    expect((await job("J-CORRUPT")).failure.deleted).toBe(0);
    expect(await snapshot()).toBe(initial);
    expect((await auditActions(env.cp, "J-CORRUPT")).some((a) => a.action === "archive_verification_failed")).toBe(true);
  });

  it("a fingerprint mismatch between the archive and the control-plane candidate set fails the key-set check", async () => {
    await exportOnly("J-FP");
    // Tamper one frozen fingerprint AND its chunk digest so only the cross-check can catch it.
    const row = (await env.cp.query(`SELECT chunk_no, pks, fingerprints, parent_keys FROM control.archive_job_candidates WHERE job_id = 'J-FP' AND attempt = 1 AND table_name = 'public.attendance' ORDER BY chunk_no LIMIT 1`)).rows[0];
    const fps = [...row.fingerprints];
    fps[0] = "AAAA" + fps[0].slice(4);
    const { chunkDigest } = await import("../../jobs/candidates");
    const digest = chunkDigest(row.pks.map((pk: string, i: number) => ({ pk, fp: fps[i], parentKey: row.parent_keys?.[i] ?? null })));
    await env.cp.query(`UPDATE control.archive_job_candidates SET fingerprints = $2, chunk_sha256 = $3 WHERE job_id = 'J-FP' AND attempt = 1 AND table_name = 'public.attendance' AND chunk_no = $1`, [row.chunk_no, fps, digest]);
    expect((await runner(env).run("J-FP")).status).toBe("failed");
    const v = (await env.cp.query(`SELECT failed_stage, checks FROM control.archive_verifications WHERE job_id = 'J-FP'`)).rows[0];
    expect(v.failed_stage).toBe("archive_key_set");
    expect(v.checks.find((c: { pass: boolean }) => !c.pass).detail).toMatch(/1 differences/);
    expect(await snapshot()).toBe(initial);
  });

  it("a schema change between freeze and verification fails the schema_hash stage", async () => {
    await exportOnly("J-SCHEMA");
    await env.app.query(`ALTER TABLE public.attendance ADD COLUMN extra text`);
    try {
      expect((await runner(env).run("J-SCHEMA")).status).toBe("failed");
      const v = (await env.cp.query(`SELECT failed_stage FROM control.archive_verifications WHERE job_id = 'J-SCHEMA'`)).rows[0];
      expect(v.failed_stage).toBe("schema_hash");
    } finally {
      await env.app.query(`ALTER TABLE public.attendance DROP COLUMN extra`);
    }
    expect(await snapshot()).toBe(initial);
  });

  it("target not reached at freeze time → job cancelled, nothing exported for deletion", async () => {
    await enableAttendanceGroup(env.cp, { target: 1_000_000 });
    await createJob(env.cp, { id: "J-SMALL", applicationId: APP_ID, groupRoot: "public.attendance", createdBy: "test", now: NOW });
    expect((await runner(env).run("J-SMALL")).status).toBe("cancelled");
    expect((await job("J-SMALL")).failure.reason).toBe("target_not_reached");
    await enableAttendanceGroup(env.cp, { target: 3000 });
  });
});
