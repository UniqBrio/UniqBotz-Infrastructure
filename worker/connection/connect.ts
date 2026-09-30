import pg from "pg";
import type { SecretResolver } from "./secrets";
import type { DatabaseConnectionConfig } from "./types";

/**
 * Session settings the row fingerprint depends on (Phase 3A P1: timestamptz text changes with TimeZone).
 * Pinned on EVERY worker connection and recorded in every manifest.
 */
export const PINNED_SESSION = {
  TimeZone: "UTC",
  DateStyle: "ISO, YMD",
  IntervalStyle: "postgres",
  extra_float_digits: "1",
  bytea_output: "hex",
} as const;

export const PINNED_SESSION_SQL = Object.entries(PINNED_SESSION)
  .map(([k, v]) => `SET ${k} = '${v}';`)
  .join("\n");

export interface OpenOptions {
  applicationName?: string;
  pin?: boolean;
}

/** Open a single dedicated connection (deletion/export need their own session; never a shared pool). */
export async function openConnection(cfg: DatabaseConnectionConfig, secrets: SecretResolver, opts: OpenOptions = {}): Promise<pg.Client> {
  const password = await secrets.resolve(cfg.passwordRef);
  const client = new pg.Client({
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password,
    ssl: cfg.sslMode === "disable" ? false : { rejectUnauthorized: cfg.sslMode === "verify-full" },
    application_name: opts.applicationName ?? `uniqbotz-worker:${cfg.purpose}`,
    connectionTimeoutMillis: 10_000,
  });
  // Phase 3A F7: a dropped connection must surface as a failed query, never crash the process.
  client.on("error", () => {});
  await client.connect();
  if (opts.pin !== false) await client.query(PINNED_SESSION_SQL);
  if (cfg.statementTimeoutMs) await client.query(`SET statement_timeout = ${Math.floor(cfg.statementTimeoutMs)}`);
  if (cfg.lockTimeoutMs) await client.query(`SET lock_timeout = ${Math.floor(cfg.lockTimeoutMs)}`);
  if (cfg.purpose === "monitor") await client.query(`SET default_transaction_read_only = on`);
  return client;
}

export function qi(ident: string): string {
  return ident
    .split(".")
    .map((p) => `"${p.replace(/"/g, '""')}"`)
    .join(".");
}

export function ql(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
