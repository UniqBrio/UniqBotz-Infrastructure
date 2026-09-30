import type { SecretRef } from "./types";

export interface SecretResolver {
  resolve(ref: SecretRef): Promise<string>;
}

export class SecretResolutionError extends Error {
  constructor(ref: string, why: string) {
    super(`cannot resolve secret ${ref}: ${why}`);
    this.name = "SecretResolutionError";
  }
}

/** Resolves `env:NAME` references from the server/worker process environment. */
export class EnvSecretResolver implements SecretResolver {
  constructor(private env: Record<string, string | undefined> = process.env) {}
  async resolve(ref: SecretRef): Promise<string> {
    if (!ref.startsWith("env:")) throw new SecretResolutionError(ref, "only env: references are supported in Phase 3B");
    const value = this.env[ref.slice(4)];
    if (!value) throw new SecretResolutionError(ref, "environment variable is not set");
    return value;
  }
}
