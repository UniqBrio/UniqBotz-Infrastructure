import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONTROL_PLANE_TABLES, migrateControlPlane } from "../../controlplane/migrate";
import { loadSettings } from "../../controlplane/repository";
import { APP_ID, createEnv, type Env } from "./harness";

let env: Env;
beforeAll(async () => { env = await createEnv("p3b_schema"); });
afterAll(async () => { await env?.close(); });

const rejects = async (sql: string, params: unknown[] = []) => {
  try { await env.cp.query(sql, params); } catch (e) { return (e as { code?: string; message: string }); }
  throw new Error(`expected failure: ${sql}`);
};

describe("control-plane schema", () => {
  it("creates all 19 documented tables and migrates idempotently", async () => {
    const r = await env.cp.query(
      `SELECT c.relname, obj_description(c.oid, 'pg_class') AS comment FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'control' AND c.relkind = 'r' ORDER BY 1`);
    expect(r.rows.map((x) => x.relname).sort()).toEqual([...CONTROL_PLANE_TABLES].sort());
    expect(r.rows.every((x) => typeof x.comment === "string" && x.comment.length > 10)).toBe(true);
    expect(await migrateControlPlane(env.cp)).toEqual([]);
  });

  it("ships safe defaults: kill switch ON, no grace period, NOT FINAL capacity, 10/11/12 lakh thresholds", async () => {
    const s = await loadSettings(env.cp);
    expect(s.deletionKillSwitch).toBe(true);
    expect(s.defaultGracePeriodDays).toBeNull();
    expect(s.recordThresholds).toEqual({ low: 1_000_000, medium: 1_100_000, high: 1_200_000 });
    expect(s.capacityThresholdsPct.final).toBe(false);
    expect(s.deletionBatchSize).toBe(2000);
    expect(s.notificationsEnabled).toBe(false);
    expect(s.schedulingEnabled).toBe(false);
  });

  it("refuses to enable notifications or scheduling in Phase 3B", async () => {
    expect((await rejects(`UPDATE control.system_settings SET notifications_enabled = true`)).code).toBe("23514");
    expect((await rejects(`UPDATE control.system_settings SET scheduling_enabled = true`)).code).toBe("23514");
    expect((await rejects(`UPDATE control.system_settings SET deletion_batch_size = 10000`)).code).toBe("23514");
  });

  it("stores secret REFERENCES only — an inline password is rejected by the database", async () => {
    const e = await rejects(
      `INSERT INTO control.application_connections (application_id, purpose, host, port, database_name, username, password_secret_ref)
       VALUES ($1, 'monitor', 'h', 5432, 'd', 'u', 'plain-text-password') ON CONFLICT (application_id, purpose) DO UPDATE SET password_secret_ref = EXCLUDED.password_secret_ref`, [APP_ID]);
    expect(e.code).toBe("23514");
    const refs = (await env.cp.query(`SELECT password_secret_ref FROM control.application_connections`)).rows.map((r) => r.password_secret_ref);
    expect(refs.every((r: string) => /^env:[A-Z_]+$/.test(r))).toBe(true);
  });

  it("audit log is append-only (UPDATE, DELETE and TRUNCATE are refused)", async () => {
    await env.cp.query(`INSERT INTO control.audit_logs (action, actor_type, actor_name, result) VALUES ('operator_action', 'user', 'test', 'info')`);
    expect((await rejects(`UPDATE control.audit_logs SET result = 'success'`)).message).toMatch(/append-only/);
    expect((await rejects(`DELETE FROM control.audit_logs`)).message).toMatch(/append-only/);
    expect((await rejects(`TRUNCATE control.audit_logs`)).message).toMatch(/append-only/);
  });

  it("policies: only ARCHIVE can be enabled; an enabled root must be complete", async () => {
    await env.cp.query(`INSERT INTO control.discovered_tables (application_id, schema_name, table_name) VALUES ($1, 'public', 't1'), ($1, 'public', 't2')`, [APP_ID]);
    await env.cp.query(`INSERT INTO control.retention_policies (application_id, schema_name, table_name) VALUES ($1, 'public', 't1')`, [APP_ID]);
    expect((await env.cp.query(`SELECT policy, enabled FROM control.retention_policies WHERE table_name = 't1'`)).rows[0]).toEqual({ policy: "REVIEW_REQUIRED", enabled: false });
    expect((await rejects(`UPDATE control.retention_policies SET enabled = true, date_column = 'd', protected_period_months = 6, target_records = 10 WHERE table_name = 't1'`)).message).toMatch(/only_archive_can_be_enabled/);
    expect((await rejects(`UPDATE control.retention_policies SET policy = 'ARCHIVE', enabled = true WHERE table_name = 't1'`)).message).toMatch(/enabled_archive_is_complete/);
  });

  it("one active job per dependency group (partial unique index)", async () => {
    const ins = (id: string, status = "queued") => env.cp.query(
      `INSERT INTO control.archive_jobs (id, application_id, group_root, tables, status, spec, created_by) VALUES ($1, $2, 'public.t1', '{public.t1}', $3, '{}', 'test')`, [id, APP_ID, status]);
    await ins("J-A");
    await expect(ins("J-B")).rejects.toMatchObject({ code: "23505" });
    await env.cp.query(`UPDATE control.archive_jobs SET status = 'cancelled' WHERE id = 'J-A'`);
    await ins("J-B");
    await env.cp.query(`DELETE FROM control.archive_jobs`);
  });
});
