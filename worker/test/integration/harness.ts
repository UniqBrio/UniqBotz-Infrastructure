/**
 * Integration-test harness — SYNTHETIC DATA ONLY, LOCAL DISPOSABLE DATABASE ONLY.
 *
 * Targets the local Supabase Postgres image started by `prototype/scripts/start-db.sh`
 * (127.0.0.1:54329). A hard safety rail refuses every other host. Each test file creates its own
 * throwaway databases (<prefix>_cp control plane, <prefix>_app synthetic application,
 * <prefix>_scratch restore target) and drops nothing outside them.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { loadWorkerConfig, type ApplicationEnvironment, type WorkerConfig } from "../../config";
import { EnvSecretResolver } from "../../connection/secrets";
import type { ApplicationConfig } from "../../connection/types";
import { LocalDirectoryStore } from "../../archive/store";
import { migrateControlPlane } from "../../controlplane/migrate";
import { registerApplication, upsertPolicy } from "../../controlplane/repository";
import { JobRunner, type RunnerDeps } from "../../jobs/runner";
import { defaultPolicy } from "../../retention/policy";

export const LOCAL = {
  host: process.env.TEST_DB_HOST ?? "127.0.0.1",
  port: Number(process.env.TEST_DB_PORT ?? 54329),
  adminPassword: "prototype-local-only",
};
if (!["127.0.0.1", "localhost", "::1"].includes(LOCAL.host)) {
  throw new Error(`SAFETY RAIL: integration tests refuse non-local host "${LOCAL.host}"`);
}

/** Synthetic placeholder credentials for the local disposable roles. Passed as env: references only. */
export const SYNTH_ROLE_PASSWORD = "synthetic-local-only";
export const SECRETS_ENV = {
  SYNTH_MONITOR_PASSWORD: SYNTH_ROLE_PASSWORD,
  SYNTH_ARCHIVE_PASSWORD: SYNTH_ROLE_PASSWORD,
  SYNTH_ARCHIVE_BYPASS_PASSWORD: SYNTH_ROLE_PASSWORD,
};
export const secrets = new EnvSecretResolver(SECRETS_ENV);

export const APP_ID = "synthetic-gym";
export const NOW = new Date("2026-09-30T06:00:00Z");
export const TZ = "Asia/Kolkata";

export async function client(database: string, user = "postgres", password = LOCAL.adminPassword): Promise<pg.Client> {
  const c = new pg.Client({ host: LOCAL.host, port: LOCAL.port, database, user, password, application_name: "uniqbotz-phase3b-tests" });
  c.on("error", () => {});
  await c.connect();
  return c;
}

async function ensureRoles(admin: pg.Client) {
  for (const [name, extra] of [["p3b_monitor", ""], ["p3b_archiver", ""], ["p3b_archiver_bypass", "BYPASSRLS"]] as const) {
    const exists = (await admin.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [name])).rowCount;
    if (!exists) await admin.query(`CREATE ROLE ${name} LOGIN PASSWORD '${SYNTH_ROLE_PASSWORD}' NOINHERIT ${extra}`);
  }
}

/** Synthetic RosiFit-like schema. No real people, phone numbers or payments. */
export const APP_SCHEMA_SQL = `
CREATE TABLE public.members (
  id bigint PRIMARY KEY, display_name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.attendance (
  id bigint PRIMARY KEY, member_id bigint NOT NULL REFERENCES public.members(id),
  checked_in_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), note text);
CREATE INDEX attendance_checked_in_at ON public.attendance (checked_in_at);
CREATE TABLE public.attendance_notes (
  id bigint PRIMARY KEY, attendance_id bigint NOT NULL REFERENCES public.attendance(id) ON DELETE CASCADE, body text NOT NULL);
CREATE INDEX attendance_notes_attendance_id ON public.attendance_notes (attendance_id);
CREATE TABLE public.private_sessions (
  id bigint PRIMARY KEY, member_id bigint NOT NULL, started_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.private_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_sessions ON public.private_sessions USING (member_id = 1);
CREATE TABLE public.app_events (id bigserial PRIMARY KEY, payload text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.lookup_codes (code text PRIMARY KEY, label text NOT NULL);

INSERT INTO public.members SELECT g, 'synthetic member ' || g, timestamptz '2024-12-01 00:00+00' FROM generate_series(1, 50) g;
-- 10 check-ins per day from 2025-01-01 to 2026-09-29 (UTC); created_at = checked_in_at (insertion history)
INSERT INTO public.attendance (id, member_id, checked_in_at, created_at, note)
SELECT row_number() OVER (ORDER BY d, i), 1 + (i * 7 + extract(doy FROM d)::int) % 50, d + make_interval(mins => 30 + i * 120), d + make_interval(mins => 30 + i * 120), 'synthetic'
FROM generate_series(timestamptz '2025-01-01 00:00+00', timestamptz '2026-09-29 00:00+00', interval '1 day') d, generate_series(0, 9) i;
-- 5 rows with no date: never eligible
INSERT INTO public.attendance (id, member_id, checked_in_at, created_at, note)
SELECT 900000 + g, 1, NULL, timestamptz '2025-06-01 00:00+00', 'undated' FROM generate_series(1, 5) g;
INSERT INTO public.attendance_notes SELECT id, id, 'synthetic note ' || id FROM public.attendance WHERE id % 3 = 0;
INSERT INTO public.private_sessions SELECT g, 1 + g % 5, timestamptz '2025-01-01 00:00+00' + make_interval(hours => g * 5), timestamptz '2025-01-01 00:00+00' + make_interval(hours => g * 5) FROM generate_series(1, 2000) g;
INSERT INTO public.app_events (payload, created_at) SELECT 'e' || g, timestamptz '2026-09-01 00:00+00' + make_interval(mins => g) FROM generate_series(1, 500) g;
INSERT INTO public.lookup_codes VALUES ('A', 'alpha'), ('B', 'beta');
ANALYZE;
`;

export interface Env {
  prefix: string;
  cp: pg.Client;
  app: pg.Client; // owner connection to the synthetic application (test assertions + simulated app activity)
  storeDir: string;
  store: LocalDirectoryStore;
  appConfig: ApplicationConfig;
  openScratch: () => Promise<pg.Client>;
  close: () => Promise<void>;
}

export function appConfig(prefix: string, patch: Partial<ApplicationConfig> = {}, archiveUser = "p3b_archiver", archivePort = LOCAL.port): ApplicationConfig {
  return {
    id: APP_ID,
    name: "Synthetic Gym (local)",
    supabaseProjectRef: null,
    environment: "synthetic",
    status: "active",
    timeZone: TZ,
    enabled: true,
    capabilities: { monitoring: true, archive: true },
    databaseCapacityMb: 500,
    connections: {
      monitor: { purpose: "monitor", host: LOCAL.host, port: LOCAL.port, database: `${prefix}_app`, user: "p3b_monitor", passwordRef: "env:SYNTH_MONITOR_PASSWORD", sslMode: "disable", statementTimeoutMs: 30_000 },
      archive: {
        purpose: "archive", host: LOCAL.host, port: archivePort, database: `${prefix}_app`, user: archiveUser,
        passwordRef: archiveUser === "p3b_archiver_bypass" ? "env:SYNTH_ARCHIVE_BYPASS_PASSWORD" : "env:SYNTH_ARCHIVE_PASSWORD", sslMode: "disable",
      },
    },
    ...patch,
  };
}

export async function createEnv(prefix: string): Promise<Env> {
  const admin = await client("postgres");
  await ensureRoles(admin);
  for (const db of [`${prefix}_cp`, `${prefix}_app`, `${prefix}_scratch`]) {
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${db}`);
  }
  await admin.end();

  const app = await client(`${prefix}_app`);
  await app.query(APP_SCHEMA_SQL);
  await app.query(`
    GRANT USAGE ON SCHEMA public TO p3b_monitor, p3b_archiver, p3b_archiver_bypass;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO p3b_monitor, p3b_archiver, p3b_archiver_bypass;
    GRANT DELETE, MAINTAIN ON public.attendance, public.attendance_notes, public.private_sessions TO p3b_archiver, p3b_archiver_bypass;`);

  const cp = await client(`${prefix}_cp`);
  await migrateControlPlane(cp);
  const cfg = appConfig(prefix);
  await registerApplication(cp, cfg);

  const storeDir = mkdtempSync(join(tmpdir(), `${prefix}-store-`));
  return {
    prefix,
    cp,
    app,
    storeDir,
    store: new LocalDirectoryStore(storeDir),
    appConfig: cfg,
    openScratch: () => client(`${prefix}_scratch`),
    close: async () => {
      await cp.end().catch(() => {});
      await app.end().catch(() => {});
    },
  };
}

/** Configure the attendance (+ notes) group as an enabled ARCHIVE policy. Operator/CLI path. */
export async function enableAttendanceGroup(cp: pg.Client, opts: { target?: number; grace?: number | null; withNotes?: boolean; root?: string; dateColumn?: string } = {}) {
  const root = opts.root ?? "attendance";
  const at = new Date().toISOString();
  await upsertPolicy(cp, {
    ...defaultPolicy(APP_ID, "public", root, at), policy: "ARCHIVE", dateColumn: opts.dateColumn ?? "checked_in_at", protectedPeriodMonths: 6,
    targetRecords: opts.target ?? 3000, gracePeriodDays: opts.grace === undefined ? 7 : opts.grace, enabled: true, groupRoot: `public.${root}`, updatedBy: "test:operator",
  });
  if (root === "attendance" && opts.withNotes !== false) {
    await upsertPolicy(cp, {
      ...defaultPolicy(APP_ID, "public", "attendance_notes", at), policy: "ARCHIVE", enabled: true, groupRoot: "public.attendance", updatedBy: "test:operator",
    });
  }
}

export function testConfig(patch: Partial<WorkerConfig> = {}): WorkerConfig {
  return { ...loadWorkerConfig({ WORKER_ID: "test-worker-a" }), leaseSeconds: 30, ...patch };
}

export function runner(env: Env, patch: Partial<RunnerDeps> & { config?: WorkerConfig } = {}) {
  return new JobRunner({ cp: env.cp, secrets, store: env.store, config: testConfig(), openScratch: env.openScratch, ...patch });
}

export async function count(c: pg.Client, sql: string, params: unknown[] = []): Promise<number> {
  return Number((await c.query(sql, params)).rows[0].n);
}

export async function auditActions(cp: pg.Client, jobId?: string): Promise<{ action: string; result: string; detail: unknown }[]> {
  return (await cp.query(`SELECT action, result, detail FROM control.audit_logs WHERE ($1::text IS NULL OR job_id = $1) ORDER BY id`, [jobId ?? null])).rows;
}

export type { ApplicationEnvironment };
