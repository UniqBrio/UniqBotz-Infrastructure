import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

/** Apply pending control-plane migrations in order, each in its own transaction. Idempotent. */
export async function migrateControlPlane(c: pg.Client): Promise<string[]> {
  await c.query(`CREATE TABLE IF NOT EXISTS public.control_schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await c.query(`SELECT name FROM public.control_schema_migrations`)).rows.map((r) => r.name as string));
  const applied: string[] = [];
  for (const file of readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(file)) continue;
    await c.query("BEGIN");
    try {
      await c.query(readFileSync(join(DIR, file), "utf8"));
      await c.query(`INSERT INTO public.control_schema_migrations (name) VALUES ($1)`, [file]);
      await c.query("COMMIT");
      applied.push(file);
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    }
  }
  await c.query(`SET search_path = control, public`);
  return applied;
}

export const CONTROL_PLANE_TABLES = [
  "applications", "application_connections", "discovered_tables", "table_columns", "foreign_keys",
  "table_stats_snapshots", "database_stats_snapshots", "retention_policies", "candidate_previews",
  "archive_jobs", "archive_job_tables", "archive_job_candidates", "archive_manifests", "archive_verifications",
  "archive_deletion_batches", "alerts", "audit_logs", "worker_leases", "system_settings",
] as const;
