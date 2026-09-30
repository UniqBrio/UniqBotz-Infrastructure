import type { ApplicationEnvironment } from "../config";

/**
 * A reference to a secret, resolved server-side at connection time. Never a secret value.
 *   env:NAME      → process.env.NAME
 *   vault:NAME    → reserved (Supabase Vault / cloud secret manager) — not implemented in Phase 3B
 */
export type SecretRef = `env:${string}` | `vault:${string}`;

export type ConnectionPurpose = "monitor" | "archive";

export interface DatabaseConnectionConfig {
  purpose: ConnectionPurpose;
  host: string;
  port: number;
  database: string;
  user: string;
  passwordRef: SecretRef;
  sslMode: "disable" | "require" | "verify-full";
  /** Role-level defaults are preferred; these are applied per session as a second layer. */
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
}

export interface ApplicationConfig {
  id: string;
  name: string;
  supabaseProjectRef: string | null;
  environment: ApplicationEnvironment;
  status: "active" | "paused" | "disabled";
  /** Business time zone (decision Q-B4). null = NOT CONFIGURED → growth, previews and jobs refuse to run. */
  timeZone: string | null;
  enabled: boolean;
  capabilities: { monitoring: boolean; archive: boolean };
  databaseCapacityMb: number | null;
  connections: Partial<Record<ConnectionPurpose, DatabaseConnectionConfig>>;
}

export function isIanaZone(tz: string): boolean {
  if (!/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(tz)) return false;
  try { new Intl.DateTimeFormat("en-CA", { timeZone: tz }); return true; } catch { return false; }
}

const SECRET_REF = /^(env|vault):[A-Za-z_][A-Za-z0-9_]*$/;

export function isSecretRef(v: string): v is SecretRef {
  return SECRET_REF.test(v);
}

/** Validate a config before it is stored or used. Rejects anything that looks like an inline secret. */
export function validateApplicationConfig(c: ApplicationConfig): string[] {
  const errors: string[] = [];
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(c.id)) errors.push("id must be lowercase letters, digits and dashes");
  if (!c.name.trim()) errors.push("name is required");
  if (c.timeZone !== null && !isIanaZone(c.timeZone)) errors.push("timeZone must be an IANA zone, e.g. Asia/Kolkata (or null = not configured)");
  if (c.environment === "production" && c.capabilities.archive) errors.push("Phase 3C: production applications are registered for READ-ONLY discovery/monitoring only (archive capability refused)");
  for (const [purpose, conn] of Object.entries(c.connections)) {
    if (!conn) continue;
    if (conn.purpose !== purpose) errors.push(`${purpose}: purpose mismatch`);
    if (!isSecretRef(conn.passwordRef)) errors.push(`${purpose}: passwordRef must be a secret reference (env:NAME), never a literal`);
    if (!Number.isInteger(conn.port) || conn.port < 1 || conn.port > 65535) errors.push(`${purpose}: invalid port`);
  }
  if (c.capabilities.archive && !c.connections.archive) errors.push("archive capability requires an archive connection");
  if (c.capabilities.monitoring && !c.connections.monitor) errors.push("monitoring capability requires a monitor connection");
  if (c.capabilities.monitoring && !(c.databaseCapacityMb && c.databaseCapacityMb > 0)) errors.push("monitoring requires databaseCapacityMb (plan capacity, e.g. 500 for Supabase Free)");
  return errors;
}
