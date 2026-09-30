/**
 * PROTOTYPE / SYNTHETIC DATA ONLY.
 * Connection helper for the disposable local Supabase Postgres started by scripts/start-db.sh.
 * A hard safety rail refuses any host other than localhost.
 */
import pg from "pg";

export const PROTO = {
  host: process.env.PROTO_DB_HOST ?? "127.0.0.1",
  port: Number(process.env.PROTO_DB_PORT ?? 54329),
  password: "prototype-local-only",
};

export const DBS = {
  rosifit: "rosifit_synth",
  jalsa: "jalsa_synth",
  wholeDay: "whole_day_synth",
  control: "control_plane_synth",
  scratch: "verify_scratch",
} as const;

function assertLocal(host: string) {
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error(`SAFETY RAIL: prototype refuses non-local host "${host}". Synthetic local databases only.`);
  }
}

/** Session settings that the row fingerprint depends on. Pinned for every connection. */
export const PINNED_SESSION_SQL = `
  SET TimeZone = 'UTC';
  SET DateStyle = 'ISO, YMD';
  SET IntervalStyle = 'postgres';
  SET extra_float_digits = 1;
  SET bytea_output = 'hex';
`;

export async function connect(database: string, opts: { user?: string; password?: string; pin?: boolean; appName?: string } = {}) {
  assertLocal(PROTO.host);
  const client = new pg.Client({
    host: PROTO.host,
    port: PROTO.port,
    database,
    user: opts.user ?? "postgres",
    password: opts.password ?? PROTO.password,
    application_name: opts.appName ?? "uniqbotz-phase3a-prototype",
  });
  await client.connect();
  if (opts.pin !== false) await client.query(PINNED_SESSION_SQL);
  return client;
}

export async function withClient<T>(database: string, fn: (c: pg.Client) => Promise<T>, opts?: Parameters<typeof connect>[1]): Promise<T> {
  const c = await connect(database, opts);
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

export async function one<T = Record<string, unknown>>(c: pg.Client, sql: string, params: unknown[] = []): Promise<T> {
  const r = await c.query(sql, params);
  return r.rows[0] as T;
}

export function qi(ident: string): string {
  return ident
    .split(".")
    .map((p) => `"${p.replace(/"/g, '""')}"`)
    .join(".");
}

export function ms(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1e6;
}

export const now = () => process.hrtime.bigint();
