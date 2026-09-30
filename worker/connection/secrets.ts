import type { SecretRef } from "./types";

/**
 * Secret management (Phase 3C §6). Secrets are REFERENCED, never stored:
 *   env:NAME     → the worker/server process environment (the only backend implemented)
 *   vault:NAME   → reserved for a managed secret store (decision S-3); refuses with SECRET_STORE_NOT_CONFIGURED
 *
 * Kinds classify what a secret unlocks, so policy (who may reference it, rotation cadence, audit) can differ:
 *   DATABASE_CONNECTION     application / control-plane database login passwords
 *   ARCHIVE_STORAGE         archive bucket credentials
 *   APPLICATION_CREDENTIAL  other per-application credentials (e.g. API keys) — never service-role keys
 *   MESSAGING               WhatsApp / email provider credentials (sending is disabled in Phase 3C)
 *
 * Failure behaviour: a missing, revoked, malformed or unsupported reference throws SecretError. It is a
 * CONFIGURATION failure: never retried in a loop, never defaulted, and the value is never logged.
 */
export type SecretKind = "DATABASE_CONNECTION" | "ARCHIVE_STORAGE" | "APPLICATION_CREDENTIAL" | "MESSAGING";
export const SECRET_KINDS: SecretKind[] = ["DATABASE_CONNECTION", "ARCHIVE_STORAGE", "APPLICATION_CREDENTIAL", "MESSAGING"];

export type SecretErrorCode = "SECRET_REF_INVALID" | "SECRET_MISSING" | "SECRET_REVOKED" | "SECRET_STORE_NOT_CONFIGURED";

const REF = /^(env|vault):([A-Za-z_][A-Za-z0-9_]*)$/;

export class SecretError extends Error {
  constructor(public code: SecretErrorCode, public ref: string, public kind: SecretKind, why: string) {
    super(`cannot resolve ${kind} secret ${REF.test(ref) ? ref : "<invalid reference>"}: ${why}`);
    this.name = "SecretError";
  }
}

/** Kept for backwards compatibility with Phase 3B callers. */
export class SecretResolutionError extends SecretError {}

export interface SecretResolver {
  resolve(ref: SecretRef, kind?: SecretKind): Promise<string>;
}

export interface SecretBackend {
  readonly scheme: "env" | "vault";
  get(name: string): Promise<string | null>;
}

export class EnvBackend implements SecretBackend {
  readonly scheme = "env" as const;
  constructor(private env: Record<string, string | undefined> = process.env) {}
  async get(name: string) {
    const v = this.env[name];
    return v ? v : null;
  }
}

export interface SecretManagerOptions {
  /** References that must no longer be used (e.g. after a leak), refused even if the value still exists. */
  revoked?: Iterable<string>;
}

/**
 * Resolves references through the configured backends. There is deliberately no cache: a rotated value is
 * picked up by the next connection, and a revoked one stops working immediately.
 */
export class SecretManager implements SecretResolver {
  private backends = new Map<string, SecretBackend>();
  private revoked: Set<string>;
  constructor(backends: SecretBackend[], opts: SecretManagerOptions = {}) {
    for (const b of backends) this.backends.set(b.scheme, b);
    this.revoked = new Set(opts.revoked ?? []);
  }

  async resolve(ref: SecretRef, kind: SecretKind = "DATABASE_CONNECTION"): Promise<string> {
    const m = REF.exec(ref);
    if (!m) throw new SecretError("SECRET_REF_INVALID", ref, kind, "not a secret reference (expected env:NAME)");
    if (this.revoked.has(ref)) throw new SecretError("SECRET_REVOKED", ref, kind, "reference has been revoked");
    const backend = this.backends.get(m[1]!);
    if (!backend) throw new SecretError("SECRET_STORE_NOT_CONFIGURED", ref, kind, `no '${m[1]}' secret store is configured`);
    const value = await backend.get(m[2]!);
    if (!value) throw new SecretError("SECRET_MISSING", ref, kind, "secret is not set");
    return value;
  }
}

/** Phase 3B-compatible resolver: env: references only; revocations from SECRETS_REVOKED (comma-separated refs). */
export class EnvSecretResolver extends SecretManager {
  constructor(env: Record<string, string | undefined> = process.env) {
    super([new EnvBackend(env)], { revoked: (env.SECRETS_REVOKED ?? "").split(",").map((s) => s.trim()).filter(Boolean) });
  }
}
