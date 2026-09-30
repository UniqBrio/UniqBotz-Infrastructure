import { PassThrough, Readable } from "node:stream";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BLOCKERS, NotReadyError } from "../../readiness/blockers";
import { EnvBackend, EnvSecretResolver, SecretError, SecretManager } from "../../connection/secrets";
import { classifyError, isRecoverable } from "../../connection/errors";
import { validateApplicationConfig, type ApplicationConfig } from "../../connection/types";
import { assertApprovedFor, ArchivePurgeDisabledError, ArchiveStorageError } from "../../archive/storage";
import { createArchiveStorage, LocalDirectoryStorage } from "../../archive/providers";
import { evaluateDeletionGate } from "../../deletion/gate";
import { approvalPolicyGaps, sameEvidence, withinDeletionWindow } from "../../approvals/approvals";
import type { SystemSettingsRow } from "../../controlplane/repository";

describe("fail-safe messages (never a guessed default)", () => {
  it("uses the exact operator-facing wording", () => {
    expect(BLOCKERS.GRACE_PERIOD_NOT_CONFIGURED).toBe("CANNOT RUN — GRACE PERIOD NOT CONFIGURED");
    expect(BLOCKERS.APPLICATION_TIMEZONE_NOT_CONFIGURED).toBe("CANNOT RUN — APPLICATION TIMEZONE NOT CONFIGURED");
    expect(BLOCKERS.RETENTION_DATE_COLUMN_NOT_CONFIGURED).toBe("CANNOT RUN — RETENTION DATE COLUMN NOT CONFIGURED");
    expect(BLOCKERS.DELETION_NOT_AUTHORIZED).toBe("DELETION NOT AUTHORIZED");
    expect(BLOCKERS.ARCHIVE_EXECUTION_UNAVAILABLE).toBe("ARCHIVE EXECUTION UNAVAILABLE");
    expect(BLOCKERS.SCHEDULING_DISABLED).toBe("SCHEDULING DISABLED");
  });
  it("NotReadyError is a configuration failure and is never retried", () => {
    const e = new NotReadyError(["GRACE_PERIOD_NOT_CONFIGURED", "APPLICATION_TIMEZONE_NOT_CONFIGURED"], "public.attendance");
    expect(e.message).toBe("CANNOT RUN — GRACE PERIOD NOT CONFIGURED; CANNOT RUN — APPLICATION TIMEZONE NOT CONFIGURED (public.attendance)");
    expect(classifyError(e)).toBe("configuration");
    expect(isRecoverable("configuration")).toBe(false);
  });
});

const app = (patch: Partial<ApplicationConfig> = {}): ApplicationConfig => ({
  id: "rosifit", name: "RosiFit", supabaseProjectRef: "placeholder", environment: "production", status: "active", timeZone: null, enabled: true,
  capabilities: { monitoring: true, archive: false }, databaseCapacityMb: 500,
  connections: { monitor: { purpose: "monitor", host: "db.example.invalid", port: 5432, database: "postgres", user: "uniqbotz_monitor", passwordRef: "env:ROSIFIT_MONITOR_PASSWORD", sslMode: "verify-full" } },
  ...patch,
});

describe("application registration", () => {
  it("allows an unconfigured time zone (null) but never an invalid one", () => {
    expect(validateApplicationConfig(app())).toEqual([]);
    expect(validateApplicationConfig(app({ timeZone: "Mars/Olympus" })).join()).toMatch(/IANA/);
    expect(validateApplicationConfig(app({ timeZone: "Asia/Kolkata" }))).toEqual([]);
  });
  it("refuses archive capability for production applications in Phase 3C (read-only discovery only)", () => {
    const c = app({ capabilities: { monitoring: true, archive: true } });
    c.connections.archive = { ...c.connections.monitor!, purpose: "archive", user: "uniqbotz_archiver", passwordRef: "env:X" };
    expect(validateApplicationConfig(c).join()).toMatch(/READ-ONLY discovery\/monitoring only/);
  });
});

describe("secret management", () => {
  it("resolves by reference and kind; missing, revoked, invalid and unsupported references fail closed", async () => {
    const m = new SecretManager([new EnvBackend({ DB_PW: "synthetic-value", MSG_KEY: "synthetic-msg" })], { revoked: ["env:MSG_KEY"] });
    await expect(m.resolve("env:DB_PW", "DATABASE_CONNECTION")).resolves.toBe("synthetic-value");
    await expect(m.resolve("env:NOPE", "ARCHIVE_STORAGE")).rejects.toMatchObject({ code: "SECRET_MISSING", kind: "ARCHIVE_STORAGE" });
    await expect(m.resolve("env:MSG_KEY", "MESSAGING")).rejects.toMatchObject({ code: "SECRET_REVOKED" });
    await expect(m.resolve("vault:DB_PW", "APPLICATION_CREDENTIAL")).rejects.toMatchObject({ code: "SECRET_STORE_NOT_CONFIGURED" });
    await expect(m.resolve("postgres://u:p@h/db" as never)).rejects.toMatchObject({ code: "SECRET_REF_INVALID" });
  });
  it("never includes a secret value or an invalid literal in the error", async () => {
    const e = (await new SecretManager([]).resolve("hunter2-literal" as never).catch((x: unknown) => x)) as SecretError;
    expect(e.message).not.toContain("hunter2");
    expect(classifyError(e)).toBe("configuration");
  });
  it("EnvSecretResolver honours SECRETS_REVOKED", async () => {
    await expect(new EnvSecretResolver({ A: "v", SECRETS_REVOKED: "env:A" }).resolve("env:A")).rejects.toMatchObject({ code: "SECRET_REVOKED" });
  });
});

describe("archive storage abstraction", () => {
  it("no provider configured → null → ARCHIVE EXECUTION UNAVAILABLE", () => {
    expect(createArchiveStorage({})).toBeNull();
    expect(() => assertApprovedFor(null, "synthetic")).toThrow(/^ARCHIVE EXECUTION UNAVAILABLE/);
  });
  it("recognised-but-undecided providers are unavailable (no provider is chosen)", () => {
    for (const p of ["s3-compatible", "gcs", "supabase-storage", "dropbox"]) {
      expect(() => createArchiveStorage({ ARCHIVE_STORAGE_PROVIDER: p })).toThrow(/ARCHIVE EXECUTION UNAVAILABLE/);
    }
  });
  it("the local test destination is approved for synthetic applications only", () => {
    const s = createArchiveStorage({ ARCHIVE_STORAGE_PROVIDER: "local-directory", ARCHIVE_STORE_DIR: mkdtempSync(join(tmpdir(), "p3c-")) })!;
    expect(assertApprovedFor(s, "synthetic")).toBe(s);
    expect(() => assertApprovedFor(s, "production")).toThrow(/not approved for 'production'/);
    expect(() => assertApprovedFor(s, "staging")).toThrow(/ARCHIVE EXECUTION UNAVAILABLE/);
  });
  it("uploads with checksum, reads metadata/versions, refuses purge and non-attempt discards", async () => {
    const s = new LocalDirectoryStorage(mkdtempSync(join(tmpdir(), "p3c-")));
    const o = await s.upload("app/J1/attempt-1/x.txt", Readable.from([Buffer.from("hello")]));
    expect(o).toMatchObject({ bytes: 5, sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" });
    expect(await s.checksum(o.key)).toBe(o.sha256);
    expect(await s.exists(o.key)).toBe(true);
    expect((await s.metadata(o.key))!.bytes).toBe(5);
    expect(await s.versions(o.key)).toHaveLength(1);
    await expect(s.purge("app/J1", { authorizedBy: "x", reason: "y", policyReference: "z" })).rejects.toBeInstanceOf(ArchivePurgeDisabledError);
    await expect(s.discardSupersededAttempt("app/J1")).rejects.toThrow(/not an export-attempt prefix/);
    await s.discardSupersededAttempt("app/J1/attempt-1");
    expect(await s.exists(o.key)).toBe(false);
  });
  it("a failing upload is a recoverable storage failure", async () => {
    const s = new LocalDirectoryStorage(mkdtempSync(join(tmpdir(), "p3c-")));
    const broken = new PassThrough();
    const p = s.upload("app/J1/attempt-1/y", broken);
    broken.destroy(new Error("network reset by provider"));
    const e = await p.catch((x) => x);
    expect(e).toBeInstanceOf(ArchiveStorageError);
    expect(classifyError(e)).toBe("storage");
    expect(isRecoverable("storage")).toBe(true);
  });
});

const settings = (patch: Partial<SystemSettingsRow["approvalPolicy"]> = {}) => ({
  approvalPolicy: { requiredApprovers: null, approvalValidityMinutes: null, excludesJobCreator: null, authorizationValidityMinutes: null, deletionWindow: null, ...patch },
}) as SystemSettingsRow;

describe("approval policy and deletion authorization (pure parts)", () => {
  it("every undecided approval rule is reported; none is defaulted", () => {
    expect(approvalPolicyGaps(settings())).toEqual(["required number of approvers", "approval validity (expiry)", "whether the job creator may approve", "authorization validity (expiry)", "deletion time window"]);
    expect(approvalPolicyGaps(settings({ requiredApprovers: 2, approvalValidityMinutes: 60, excludesJobCreator: true, authorizationValidityMinutes: 30,
      deletionWindow: { start: "22:00", end: "05:00", timeZone: "Asia/Kolkata" } }))).toEqual([]);
  });
  it("deletion windows are evaluated in their own time zone, including windows that wrap midnight", () => {
    const w = { start: "22:00:00", end: "05:00:00", timeZone: "Asia/Kolkata" };
    expect(withinDeletionWindow(new Date("2026-09-30T17:00:00Z"), w)).toBe(true); // 22:30 IST
    expect(withinDeletionWindow(new Date("2026-09-30T22:00:00Z"), w)).toBe(true); // 03:30 IST
    expect(withinDeletionWindow(new Date("2026-09-30T06:00:00Z"), w)).toBe(false); // 11:30 IST
  });
  it("evidence binding requires every element to match", () => {
    const e = { attempt: 1, manifestSha256: "m", schemaHash: "s", graphHash: "g", candidateDigest: "c" };
    expect(sameEvidence(e, { ...e })).toBe(true);
    for (const k of ["attempt", "manifestSha256", "schemaHash", "graphHash", "candidateDigest"] as const) {
      expect(sameEvidence(e, { ...e, [k]: k === "attempt" ? 2 : "x" })).toBe(false);
    }
    expect(sameEvidence({ ...e, manifestSha256: null }, { ...e, manifestSha256: null })).toBe(false);
  });
  it("the worker gate treats a missing authorization evaluation as NOT AUTHORIZED", () => {
    const r = evaluateDeletionGate({
      config: { allowDeletion: true, deletionAllowedEnvironments: ["synthetic"], verificationMaxAgeMinutes: 60 }, environment: "synthetic", killSwitch: false,
      jobStatus: "deletion_approved", jobMode: "ARCHIVE_VERIFY_DELETE", verification: { verified: true, attempt: 1, verifiedAt: new Date().toISOString() },
      currentAttempt: 1, jobSchemaHash: "s", liveSchemaHash: "s", jobGraphHash: "g", liveGraphHash: "g", candidateSetIntact: true,
    });
    expect(r.allowed).toBe(false);
    expect(r.reasons.join()).toMatch(/DELETION NOT AUTHORIZED/);
  });
});
