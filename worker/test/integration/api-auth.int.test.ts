/**
 * Control-plane API authentication/authorization — through the real route handlers, against a throwaway
 * local control plane. SYNTHETIC ONLY. The signing secret below is a test placeholder.
 */
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signHs256 } from "@/server/auth/jwt";
import { collectApplication } from "../../health/collector";
import { createJob } from "../../jobs/jobs";
import { registerApplication } from "../../controlplane/repository";
import {
  APP_ID, appConfig, configureTestApprovalPolicy, count, createEnv, createTestOperators, enableAttendanceGroup, LOCAL, NOW, runner, secrets, type Env,
} from "./harness";

const SECRET = "synthetic-api-test-secret-placeholder";
const URL_BASE = `postgres://postgres:${LOCAL.adminPassword}@${LOCAL.host}:${LOCAL.port}/p3c_api_cp`;
let env: Env;
let route: typeof import("@/app/api/infra/[...path]/route");

const token = (sub: string, patch: Record<string, unknown> = {}) => {
  const t = Math.floor(Date.now() / 1000);
  return signHs256({ sub, email: `${sub}@synthetic.invalid`, iss: "synthetic-idp", aud: "uniqbotz-control-plane", iat: t, exp: t + 600, ...patch }, SECRET);
};

async function call(method: "GET" | "POST" | "PUT", path: string, opts: { as?: string; cookieAs?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.as) headers.authorization = `Bearer ${token(opts.as)}`;
  if (opts.cookieAs) headers.cookie = `uniqbotz_session=${token(opts.cookieAs)}`;
  const req = new NextRequest(new URL(`http://localhost/api/infra/${path}`), { method, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const ctx = { params: Promise.resolve({ path: path.split("?")[0]!.split("/") }) } as never;
  const res = method === "GET" ? await route.GET(req, ctx) : method === "POST" ? await route.POST(req, ctx) : await route.PUT();
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  env = await createEnv("p3c_api");
  Object.assign(process.env, {
    CONTROL_PLANE_DATABASE_URL: URL_BASE,
    CONTROL_PLANE_WRITER_DATABASE_URL: URL_BASE,
    CONTROL_PLANE_AUTH_MODE: "jwt-hs256",
    CONTROL_PLANE_AUTH_SECRET_REF: "env:P3C_TEST_AUTH_SECRET",
    P3C_TEST_AUTH_SECRET: SECRET,
    CONTROL_PLANE_AUTH_ISSUER: "synthetic-idp",
    CONTROL_PLANE_AUTH_AUDIENCE: "uniqbotz-control-plane",
  });
  route = await import("@/app/api/infra/[...path]/route");
  await collectApplication(env.cp, secrets, APP_ID, { now: NOW });
  await enableAttendanceGroup(env.cp, { target: 400 });
  await createTestOperators(env.cp);
  await configureTestApprovalPolicy(env.cp);
  await createJob(env.cp, { id: "API-1", applicationId: APP_ID, groupRoot: "public.attendance", createdBy: "operator-d", mode: "ARCHIVE_VERIFY_DELETE", now: NOW });
  expect((await runner(env).run("API-1")).status).toBe("ready_for_deletion");
});
afterAll(async () => {
  for (const k of ["CONTROL_PLANE_AUTH_MODE", "CONTROL_PLANE_WRITER_DATABASE_URL", "P3C_TEST_AUTH_SECRET"]) delete process.env[k];
  await env?.close();
});

describe("authentication", () => {
  it("session: anonymous vs signed-in with roles from the control plane", async () => {
    expect((await call("GET", "session")).body).toMatchObject({ authMode: "jwt-hs256", authenticated: false, productionDeletion: "DISABLED" });
    const s = (await call("GET", "session", { as: "approver-a" })).body;
    expect(s).toMatchObject({ authenticated: true, subject: "approver-a", roles: ["APPROVER"], productionDeletion: "DISABLED" });
    expect(s.permissions).toContain("approve_deletion");
    expect(s.permissions).not.toContain("execute_deletion");
    expect((await call("GET", "session", { as: "stranger" })).body).toMatchObject({ authenticated: true, roles: [], notice: expect.stringMatching(/no role/) });
  });
  it("reads require a signed-in VIEWER+", async () => {
    expect((await call("GET", "applications")).status).toBe(401);
    expect((await call("GET", "applications", { as: "stranger" })).status).toBe(403);
    const ok = await call("GET", "applications", { as: "viewer-e" });
    expect(ok.status).toBe(200);
    expect(JSON.stringify(ok.body)).not.toMatch(/env:|SYNTH_|password/i);
    expect((await call("GET", "applications", { cookieAs: "viewer-e" })).status).toBe(200); // cookie is fine for reads
  });
});

describe("deletion review, approvals and authorization through the API", () => {
  it("the review shows the evidence and PRODUCTION DELETION DISABLED", async () => {
    const r = await call("GET", "jobs/API-1/review", { as: "viewer-e" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ jobId: "API-1", mode: "ARCHIVE_VERIFY_DELETE", productionDeletion: "DISABLED", candidateSetIntact: true });
    expect(r.body.evidence.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.body.verification).toMatchObject({ verified: true, keySetPassed: true, restoreFingerprintPassed: true, schemaHashPassed: true });
    expect(r.body.blockers[0]).toMatch(/PRODUCTION DELETION DISABLED/);
    expect(r.body.impact[0]).toMatchObject({ table: "attendance" });
  });
  it("approvals: role-checked, CSRF-safe, evidence-bound, no duplicates", async () => {
    const evidenceAck = (await call("GET", "jobs/API-1/review", { as: "viewer-e" })).body.evidence;
    expect((await call("POST", "jobs/API-1/approvals", { as: "viewer-e", body: { decision: "approve", evidenceAck } })).status).toBe(403);
    expect((await call("POST", "jobs/API-1/approvals", { cookieAs: "approver-a", body: { decision: "approve", evidenceAck } })).body.code).toBe("CSRF_PROTECTION");
    const stale = await call("POST", "jobs/API-1/approvals", { as: "approver-a", body: { decision: "approve", evidenceAck: { ...evidenceAck, candidateDigest: "x" } } });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatch(/^DELETION NOT AUTHORIZED/);
    const ok = await call("POST", "jobs/API-1/approvals", { as: "approver-a", body: { decision: "approve", evidenceAck, comment: "checked" } });
    expect(ok.status).toBe(201);
    expect(ok.body.productionDeletion).toBe("DISABLED");
    expect((await call("POST", "jobs/API-1/approvals", { as: "approver-a", body: { decision: "approve", evidenceAck } })).body.code).toBe("DUPLICATE_APPROVAL");
  });
  it("authorization: ADMIN only, quorum required; the web tier still deletes nothing", async () => {
    const evidenceAck = (await call("GET", "jobs/API-1/review", { as: "viewer-e" })).body.evidence;
    expect((await call("POST", "jobs/API-1/authorization", { as: "approver-b", body: { evidenceAck, confirmJobId: "API-1" } })).status).toBe(403);
    const early = await call("POST", "jobs/API-1/authorization", { as: "admin-c", body: { evidenceAck, confirmJobId: "API-1" } });
    expect(early.status).toBe(409);
    expect(early.body.reasons.join()).toMatch(/quorum not met \(1 of 2/);
    await call("POST", "jobs/API-1/approvals", { as: "approver-b", body: { decision: "approve", evidenceAck } });
    const before = await count(env.app, `SELECT count(*) n FROM public.attendance`);
    const ok = await call("POST", "jobs/API-1/authorization", { as: "admin-c", body: { evidenceAck, confirmJobId: "API-1" } });
    expect(ok.status).toBe(201);
    expect(ok.body.note).toMatch(/worker re-validates/);
    expect(await count(env.app, `SELECT count(*) n FROM public.attendance`)).toBe(before);
    const review = (await call("GET", "jobs/API-1/review", { as: "viewer-e" })).body;
    expect(review.approvals.filter((a: { counts: boolean }) => a.counts)).toHaveLength(2);
    expect(review.authorizations).toHaveLength(1);
  });
  it("starting archive verification: OPERATOR only, always ARCHIVE_AND_VERIFY_ONLY; duplicates refused", async () => {
    expect((await call("POST", "jobs", { as: "viewer-e", body: { applicationId: APP_ID, groupRoot: "public.attendance" } })).status).toBe(403);
    expect((await call("POST", "jobs", { as: "operator-d", body: { applicationId: APP_ID, groupRoot: "public.attendance" } })).body.code).toBe("DUPLICATE_JOB");
    expect((await call("POST", "jobs/API-1/cancel", { as: "operator-d", body: { reason: "api test" } })).status).toBe(200);
    const created = await call("POST", "jobs", { as: "operator-d", body: { applicationId: APP_ID, groupRoot: "public.attendance", mode: "ARCHIVE_VERIFY_DELETE" } });
    expect(created.status).toBe(201);
    expect(created.body.mode).toBe("ARCHIVE_AND_VERIFY_ONLY");
    expect((await env.cp.query(`SELECT mode FROM control.archive_jobs WHERE id = $1`, [created.body.jobId])).rows[0].mode).toBe("ARCHIVE_AND_VERIFY_ONLY");
  });
});

describe("kill switch and unsupported writes", () => {
  it("engage: OPERATOR+; release: ADMIN only", async () => {
    expect((await call("POST", "kill-switch", { as: "viewer-e", body: { engaged: true, reason: "x" } })).status).toBe(403);
    expect((await call("POST", "kill-switch", { as: "operator-d", body: { engaged: true, reason: "drill" } })).status).toBe(200);
    expect((await call("POST", "kill-switch", { as: "operator-d", body: { engaged: false, reason: "x" } })).status).toBe(403);
    expect((await call("POST", "kill-switch", { as: "admin-c", body: { engaged: false, reason: "drill over" } })).body).toEqual({ engaged: false, changed: true });
    expect((await call("POST", "kill-switch", { as: "admin-c", body: { engaged: true, reason: "restore default" } })).body.changed).toBe(true);
  });
  it("policy/settings edits and direct deletion have no dashboard write path; PUT is refused", async () => {
    const r = await call("POST", "jobs/API-1/delete", { as: "admin-c" });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/READ-ONLY.*Deletion is DISABLED/);
    expect((await call("PUT", "settings", { as: "admin-c" })).status).toBe(403);
  });
});

describe("authentication NOT configured", () => {
  it("writes are READ-ONLY; anonymous reads stop as soon as a production application is registered", async () => {
    const saved = process.env.CONTROL_PLANE_AUTH_MODE;
    delete process.env.CONTROL_PLANE_AUTH_MODE;
    try {
      const w = await call("POST", "kill-switch", { as: "admin-c", body: { engaged: false, reason: "x" } });
      expect(w.status).toBe(403);
      expect(w.body.error).toMatch(/READ-ONLY: AUTHENTICATION NOT CONFIGURED/);
      expect((await call("GET", "applications")).status).toBe(200); // synthetic only so far
      const prod = appConfig("p3c_api", { id: "prod-readonly", name: "Production (read-only placeholder)", environment: "production", timeZone: null, capabilities: { monitoring: true, archive: false } });
      delete prod.connections.archive;
      await registerApplication(env.cp, prod);
      const r = await call("GET", "applications");
      expect(r.status).toBe(401);
      expect(r.body.error).toMatch(/AUTHENTICATION NOT CONFIGURED — production application data requires authentication/);
    } finally {
      process.env.CONTROL_PLANE_AUTH_MODE = saved;
      await env.cp.query(`DELETE FROM control.application_connections WHERE application_id = 'prod-readonly'`);
      await env.cp.query(`DELETE FROM control.applications WHERE id = 'prod-readonly'`);
    }
  });
});
