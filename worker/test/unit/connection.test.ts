import { describe, expect, it } from "vitest";
import { EnvSecretResolver } from "../../connection/secrets";
import { isSecretRef, validateApplicationConfig, type ApplicationConfig } from "../../connection/types";
import { classifyError, isRecoverable } from "../../connection/errors";
import { decideRetry } from "../../recovery/retry";

const base = (): ApplicationConfig => ({
  id: "synthetic-gym",
  name: "Synthetic gym",
  supabaseProjectRef: null,
  environment: "synthetic",
  status: "active",
  timeZone: "Asia/Kolkata",
  enabled: true,
  capabilities: { monitoring: true, archive: false },
  databaseCapacityMb: 500,
  connections: {
    monitor: { purpose: "monitor", host: "127.0.0.1", port: 54329, database: "x", user: "monitor", passwordRef: "env:SYNTH_MONITOR_PASSWORD", sslMode: "disable" },
  },
});

describe("application connection config — secrets are references, never values", () => {
  it("accepts env: references", () => {
    expect(validateApplicationConfig(base())).toEqual([]);
    expect(isSecretRef("env:ROSIFIT_MONITOR_PASSWORD")).toBe(true);
  });

  it("rejects an inline password", () => {
    const c = base();
    (c.connections.monitor as { passwordRef: string }).passwordRef = "hunter2";
    expect(validateApplicationConfig(c).join()).toMatch(/secret reference/);
    expect(isSecretRef("postgres://u:p@h/db")).toBe(false);
  });

  it("requires a matching connection per capability and a plan capacity for monitoring", () => {
    const c = base();
    c.capabilities.archive = true;
    c.databaseCapacityMb = null;
    const errors = validateApplicationConfig(c).join("\n");
    expect(errors).toMatch(/archive capability requires an archive connection/);
    expect(errors).toMatch(/databaseCapacityMb/);
  });

  it("EnvSecretResolver resolves env: only and fails loudly when unset", async () => {
    const r = new EnvSecretResolver({ A: "synthetic-placeholder" });
    await expect(r.resolve("env:A")).resolves.toBe("synthetic-placeholder");
    await expect(r.resolve("env:MISSING")).rejects.toThrow(/not set/);
    await expect(r.resolve("vault:A")).rejects.toThrow(/no 'vault' secret store is configured/);
  });
});

describe("connection failures become recoverable worker failures", () => {
  it("classifies driver and SQLSTATE errors", () => {
    expect(classifyError(new Error("connect ECONNREFUSED 127.0.0.1:1"))).toBe("transient");
    expect(classifyError(new Error("Connection terminated unexpectedly"))).toBe("transient");
    expect(classifyError({ code: "08006", message: "x" })).toBe("transient");
    expect(classifyError({ code: "55P03", message: "lock" })).toBe("lock_timeout");
    expect(classifyError({ code: "25006", message: "read only" })).toBe("read_only");
    expect(classifyError({ code: "28P01", message: "auth" })).toBe("auth");
    expect(classifyError({ code: "42P01", message: "missing" })).toBe("schema");
    expect(isRecoverable("read_only")).toBe(false);
    expect(isRecoverable("schema")).toBe(false);
  });

  it("backs off exponentially and stops after the retry budget", () => {
    const e = new Error("ECONNRESET");
    expect(decideRetry(e, 0)).toMatchObject({ retry: true, delayMs: 5000 });
    expect(decideRetry(e, 2)).toMatchObject({ retry: true, delayMs: 20000 });
    expect(decideRetry(e, 5).retry).toBe(false);
    expect(decideRetry({ code: "42703", message: "column" }, 0).retry).toBe(false);
  });
});
