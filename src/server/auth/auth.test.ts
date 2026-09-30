import { describe, expect, it } from "vitest";
import { can, permissionsFor, ROLE_PERMISSIONS, ROLES } from "@/lib/auth/permissions";
import { signHs256, verifyHs256 } from "./jwt";
import { authenticate, HttpError, loadAuthConfig, requirePrincipal } from "./session";

const SECRET = "synthetic-test-signing-secret-not-real";
const NOW = new Date("2026-09-30T06:00:00Z");
const t = Math.floor(NOW.getTime() / 1000);
const claims = (patch: Record<string, unknown> = {}) => ({ sub: "approver-a", email: "a@synthetic.invalid", iss: "test-idp", aud: "uniqbotz-control-plane", iat: t - 60, exp: t + 600, ...patch });
const opts = { issuer: "test-idp", audience: "uniqbotz-control-plane", now: NOW };

describe("authentication — HS256 session tokens", () => {
  it("accepts a valid token", () => {
    expect(verifyHs256(signHs256(claims(), SECRET), SECRET, opts)).toMatchObject({ sub: "approver-a", email: "a@synthetic.invalid" });
  });
  it.each([
    ["missing", null, "TOKEN_MISSING"],
    ["expired", signHs256(claims({ exp: t - 120 }), SECRET), "TOKEN_EXPIRED"],
    ["no expiry", signHs256(claims({ exp: undefined }), SECRET), "TOKEN_EXPIRED"],
    ["wrong signature", signHs256(claims(), "another-secret"), "TOKEN_SIGNATURE"],
    ["alg none", `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims())).toString("base64url")}.`, "TOKEN_ALG"],
    ["wrong issuer", signHs256(claims({ iss: "evil" }), SECRET), "TOKEN_ISSUER"],
    ["wrong audience", signHs256(claims({ aud: "other" }), SECRET), "TOKEN_AUDIENCE"],
    ["no subject", signHs256(claims({ sub: "" }), SECRET), "TOKEN_SUBJECT"],
    ["not yet valid", signHs256(claims({ nbf: t + 3600 }), SECRET), "TOKEN_NOT_YET_VALID"],
    ["malformed", "abc.def", "TOKEN_MALFORMED"],
  ])("rejects %s", (_n, token, code) => {
    expect(() => verifyHs256(token as string | null, SECRET, opts)).toThrow(expect.objectContaining({ code }));
  });
  it("enforces a maximum session age when configured", () => {
    expect(() => verifyHs256(signHs256(claims({ iat: t - 7200 }), SECRET), SECRET, { ...opts, maxAgeSeconds: 3600 })).toThrow(expect.objectContaining({ code: "TOKEN_TOO_OLD" }));
  });
});

const ENV = { CONTROL_PLANE_AUTH_MODE: "jwt-hs256", CONTROL_PLANE_AUTH_SECRET_REF: "env:TEST_AUTH_SECRET", TEST_AUTH_SECRET: SECRET,
  CONTROL_PLANE_AUTH_ISSUER: "test-idp", CONTROL_PLANE_AUTH_AUDIENCE: "uniqbotz-control-plane" };
const req = (headers: Record<string, string> = {}) => new Request("http://localhost/api/infra/x", { headers });
const lookup = (roles: Record<string, string[]>) => async (sub: string) => (roles[sub] ? { active: true, roles: roles[sub] as never } : null);

describe("authentication boundary configuration", () => {
  it("is disabled by default (AUTHENTICATION NOT CONFIGURED)", async () => {
    expect(loadAuthConfig({}).mode).toBe("disabled");
    expect(await authenticate(req(), {})).toEqual({ status: "disabled", reason: "AUTHENTICATION NOT CONFIGURED" });
  });
  it("refuses to start half-configured: missing issuer/audience or an inline secret", async () => {
    const s = await authenticate(req(), { CONTROL_PLANE_AUTH_MODE: "jwt-hs256", CONTROL_PLANE_AUTH_SECRET_REF: "plain-secret" });
    expect(s.status).toBe("misconfigured");
    expect((s as { reason: string }).reason).toMatch(/AUTHENTICATION NOT CONFIGURED.*secret reference.*ISSUER.*AUDIENCE/);
  });
  it("refuses when the signing secret reference cannot be resolved", async () => {
    const s = await authenticate(req({ authorization: `Bearer ${signHs256(claims(), SECRET)}` }), { ...ENV, TEST_AUTH_SECRET: undefined });
    expect(s).toMatchObject({ status: "misconfigured" });
    expect(JSON.stringify(s)).not.toContain(SECRET);
  });
  it("reads the token from the Authorization header or the session cookie", async () => {
    expect(await authenticate(req({ authorization: `Bearer ${signHs256(claims(), SECRET)}` }), ENV, NOW)).toMatchObject({ status: "authenticated", via: "header" });
    expect(await authenticate(req({ cookie: `a=b; uniqbotz_session=${signHs256(claims(), SECRET)}` }), ENV, NOW)).toMatchObject({ status: "authenticated", via: "cookie" });
    expect(await authenticate(req(), ENV, NOW)).toMatchObject({ status: "anonymous" });
  });
});

describe("authorization — roles come from the control plane, never from the token", () => {
  const token = (sub: string, extra: Record<string, unknown> = {}) => `Bearer ${signHs256(claims({ sub, ...extra }), SECRET)}`;
  const roles = lookup({ "approver-a": ["APPROVER"], "viewer-e": ["VIEWER"], "admin-c": ["ADMIN"] });
  const run = (sub: string, action: Parameters<typeof requirePrincipal>[1], write = true, headers?: Record<string, string>) =>
    requirePrincipal(req(headers ?? { authorization: token(sub) }), action, roles, { write, env: ENV, now: NOW });

  it("grants what the role allows", async () => {
    await expect(run("approver-a", "approve_deletion")).resolves.toMatchObject({ subject: "approver-a", roles: ["APPROVER"] });
    await expect(run("admin-c", "release_kill_switch")).resolves.toMatchObject({ roles: ["ADMIN"] });
  });
  it("refuses what the role does not allow (403) and unknown subjects (no roles)", async () => {
    await expect(run("viewer-e", "approve_deletion")).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    await expect(run("admin-c", "approve_deletion")).rejects.toMatchObject({ status: 403 });
    await expect(run("stranger", "view", false)).rejects.toMatchObject({ status: 403 });
  });
  it("ignores role claims inside the token", async () => {
    await expect(run("viewer-e", "authorize_deletion", true, { authorization: token("viewer-e", { roles: ["ADMIN"], role: "service_role" }) })).rejects.toMatchObject({ status: 403 });
  });
  it("writes require the Authorization header (a cookie alone is refused: CSRF protection)", async () => {
    await expect(run("approver-a", "approve_deletion", true, { cookie: `uniqbotz_session=${signHs256(claims(), SECRET)}` })).rejects.toMatchObject({ status: 403, code: "CSRF_PROTECTION" });
  });
  it("with authentication not configured, writes are READ-ONLY (403) and reads need auth (401)", async () => {
    const w = await requirePrincipal(req(), "approve_deletion", roles, { write: true, env: {} }).catch((e: HttpError) => e);
    expect(w).toMatchObject({ status: 403, code: "AUTHENTICATION_NOT_CONFIGURED" });
    expect((w as HttpError).message).toMatch(/READ-ONLY/);
    await expect(requirePrincipal(req(), "view", roles, { write: false, env: {} })).rejects.toMatchObject({ status: 401 });
  });
  it("expired or forged tokens are 401", async () => {
    await expect(run("approver-a", "view", false, { authorization: `Bearer ${signHs256(claims({ exp: t - 999 }), SECRET)}` })).rejects.toMatchObject({ status: 401 });
    await expect(run("approver-a", "view", false, { authorization: `Bearer ${signHs256(claims(), "forged")}` })).rejects.toMatchObject({ status: 401 });
  });
});

describe("role / permission matrix", () => {
  it("nobody can execute deletion from the dashboard", () => {
    for (const r of ROLES) expect(can([r], "execute_deletion")).toBe(false);
    expect(permissionsFor([...ROLES])).not.toContain("execute_deletion");
  });
  it("separates viewing, approving, authorizing and kill-switch release", () => {
    expect(ROLE_PERMISSIONS.VIEWER).toEqual(["view"]);
    expect(can(["OPERATOR"], "start_archive_verification")).toBe(true);
    expect(can(["OPERATOR"], "approve_deletion")).toBe(false);
    expect(can(["OPERATOR"], "change_retention")).toBe(false);
    expect(can(["APPROVER"], "approve_deletion")).toBe(true);
    expect(can(["APPROVER"], "authorize_deletion")).toBe(false);
    expect(can(["ADMIN"], "authorize_deletion")).toBe(true);
    expect(can(["ADMIN"], "approve_deletion")).toBe(false);
    for (const r of ["OPERATOR", "APPROVER", "ADMIN"] as const) expect(can([r], "engage_kill_switch")).toBe(true);
    expect(can(["VIEWER"], "engage_kill_switch")).toBe(false);
    expect(can(["OPERATOR", "APPROVER"], "release_kill_switch")).toBe(false);
    expect(can(["ADMIN"], "release_kill_switch")).toBe(true);
    expect(can(["ADMIN"], "change_credentials")).toBe(true);
    expect(can(["OPERATOR"], "change_credentials")).toBe(false);
  });
});
