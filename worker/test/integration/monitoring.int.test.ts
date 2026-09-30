import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openConnection } from "../../connection/connect";
import { listPolicies, registerApplication } from "../../controlplane/repository";
import { discoverDatabase } from "../../discovery/catalog";
import { collectApplication } from "../../health/collector";
import { previewCandidate } from "../../candidates/preview";
import { planGroup } from "../../retention/group";
import { APP_ID, appConfig, auditActions, count, createEnv, enableAttendanceGroup, LOCAL, NOW, secrets, TZ, type Env } from "./harness";

let env: Env;
beforeAll(async () => {
  env = await createEnv("p3b_monitor");
  process.env.CONTROL_PLANE_DATABASE_URL = `postgres://postgres:${LOCAL.adminPassword}@${LOCAL.host}:${LOCAL.port}/p3b_monitor_cp`;
});
afterAll(async () => { await env?.close(); });

const appRows = () => count(env.app, `SELECT (SELECT count(*) FROM public.attendance) + (SELECT count(*) FROM public.attendance_notes) AS n`);

describe("read-only monitoring connection", () => {
  it("the monitor session cannot write, even to a table it could otherwise modify", async () => {
    const c = await openConnection(env.appConfig.connections.monitor!, secrets);
    try {
      await expect(c.query(`CREATE TABLE public.should_not_exist (id int)`)).rejects.toMatchObject({ code: "25006" });
      await expect(c.query(`DELETE FROM public.lookup_codes`)).rejects.toMatchObject({ code: "25006" });
      expect((await c.query(`SHOW TimeZone`)).rows[0].TimeZone).toBe("UTC"); // pinned session
    } finally { await c.end(); }
  });
});

describe("discovery", () => {
  it("discovers tables, PKs, FKs (with ON DELETE), RLS, date candidates and the insertion column — without assuming created_at", async () => {
    const c = await openConnection(env.appConfig.connections.monitor!, secrets);
    try {
      const d = await discoverDatabase(c);
      const by = Object.fromEntries(d.tables.map((t) => [t.qualified, t]));
      expect(Object.keys(by).sort()).toEqual(["public.app_events", "public.attendance", "public.attendance_notes", "public.lookup_codes", "public.members", "public.private_sessions"]);
      expect(by["public.attendance"]!.primaryKey).toEqual(["id"]);
      expect(by["public.attendance"]!.dateCandidates.sort()).toEqual(["checked_in_at", "created_at"]);
      expect(by["public.attendance"]!.insertionColumn).toBe("created_at");
      expect(by["public.attendance_notes"]!.insertionColumn).toBeNull();
      expect(by["public.lookup_codes"]!.dateCandidates).toEqual([]);
      expect(by["public.private_sessions"]!.rls.enabled).toBe(true);
      expect(d.foreignKeys.map((e) => `${e.child}->${e.parent}:${e.onDelete}`).sort()).toEqual([
        "public.attendance->public.members:NO ACTION", "public.attendance_notes->public.attendance:CASCADE"]);
      expect(d.tables.some((t) => ["auth", "storage", "pg_catalog"].includes(t.schema))).toBe(false);
    } finally { await c.end(); }
  });
});

describe("health collection (manual trigger, read-only)", () => {
  it("persists discovery; every new table is REVIEW_REQUIRED and audited", async () => {
    const before = await appRows();
    const r = await collectApplication(env.cp, secrets, APP_ID, { now: NOW });
    expect(r.ok).toBe(true);
    expect(r.newTables).toHaveLength(6);
    const policies = await listPolicies(env.cp, APP_ID);
    expect(policies).toHaveLength(6);
    expect(policies.every((p) => p.policy === "REVIEW_REQUIRED" && !p.enabled && p.gracePeriodDays === null)).toBe(true);
    const audit = await auditActions(env.cp);
    expect(audit.filter((a) => a.action === "table_discovered")).toHaveLength(6);
    expect(audit.filter((a) => a.action === "policy_defaulted")).toHaveLength(6);
    expect(await appRows()).toBe(before);
    const app = (await env.cp.query(`SELECT connection_status, server_version FROM control.applications WHERE id = $1`, [APP_ID])).rows[0];
    expect(app.connection_status).toBe("connected");
    expect(app.server_version).toMatch(/^17\./);
  });

  it("measures six-month growth from the insertion timestamp in the app time zone, and reports INSUFFICIENT HISTORY otherwise", async () => {
    const g = Object.fromEntries((await env.cp.query(`SELECT table_name, growth, exact_rows FROM control.discovered_tables WHERE application_id = $1`, [APP_ID])).rows
      .map((r) => [r.table_name, r]));
    expect(g.attendance.growth).toMatchObject({ status: "measured", column: "created_at", timeZone: TZ, windowStart: "2026-03-01", windowEnd: "2026-09-01", days: 184, recordsInWindow: 1840, avgPerDay: 10 });
    expect(g.attendance.growth.monthly.map((m: { recordsAdded: number }) => m.recordsAdded)).toEqual([310, 300, 310, 300, 310, 310]);
    expect(g.app_events.growth.status).toBe("insufficient_history"); // oldest row is newer than the window
    expect(g.lookup_codes.growth).toMatchObject({ status: "insufficient_history", column: null });
    expect(g.attendance_notes.growth.status).toBe("insufficient_history");
    expect(g.private_sessions.growth.reason).toMatch(/row-level security/);
    expect(g.private_sessions.exact_rows).toBeNull();
    expect(Number(g.attendance.exact_rows)).toBe(6375);
  });

  it("writes daily snapshots and alerts only past the configured thresholds (notifications disabled)", async () => {
    expect(await count(env.cp, `SELECT count(*) n FROM control.table_stats_snapshots WHERE captured_on = '2026-09-30'`)).toBe(6);
    expect(await count(env.cp, `SELECT count(*) n FROM control.alerts`)).toBe(0);
    await env.cp.query(`UPDATE control.system_settings SET record_threshold_low = 5000, record_threshold_medium = 6000, record_threshold_high = 7000`);
    await collectApplication(env.cp, secrets, APP_ID, { now: NOW });
    const a = (await env.cp.query(`SELECT table_name, level, notification FROM control.alerts WHERE state = 'active'`)).rows;
    expect(a).toEqual([{ table_name: "attendance", level: "MEDIUM", notification: { whatsapp: "disabled", email: "disabled" } }]);
    await env.cp.query(`UPDATE control.system_settings SET record_threshold_low = 1000000, record_threshold_medium = 1100000, record_threshold_high = 1200000`);
    await collectApplication(env.cp, secrets, APP_ID, { now: NOW });
    expect(await count(env.cp, `SELECT count(*) n FROM control.alerts WHERE state = 'active'`)).toBe(0);
    expect(await count(env.cp, `SELECT count(*) n FROM control.table_stats_snapshots`)).toBe(6); // one per table per day
  });

  it("a table created later is discovered as REVIEW_REQUIRED and never archived automatically", async () => {
    await env.app.query(`CREATE TABLE public.late_table (id int PRIMARY KEY, happened_at timestamptz); GRANT SELECT ON public.late_table TO p3b_monitor`);
    const r = await collectApplication(env.cp, secrets, APP_ID, { now: NOW });
    expect(r.newTables).toEqual(["public.late_table"]);
    const p = (await listPolicies(env.cp, APP_ID)).find((x) => x.tableName === "late_table")!;
    expect(p).toMatchObject({ policy: "REVIEW_REQUIRED", enabled: false });
    expect(r.previews).toEqual([]);
  });

  it("an unreachable application becomes 'disconnected' and the failure is audited (no crash)", async () => {
    const bad = appConfig("p3b_monitor", { id: "synthetic-offline", name: "Offline synthetic" });
    bad.connections.monitor = { ...bad.connections.monitor!, port: 1 };
    bad.connections.archive = { ...bad.connections.archive!, port: 1 };
    await registerApplication(env.cp, bad);
    const r = await collectApplication(env.cp, secrets, "synthetic-offline", { now: NOW });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^transient/);
    expect((await env.cp.query(`SELECT connection_status FROM control.applications WHERE id = 'synthetic-offline'`)).rows[0].connection_status).toBe("disconnected");
    expect((await auditActions(env.cp)).some((a) => a.action === "collection_failed")).toBe(true);
  });
});

describe("candidate preview (read-only)", () => {
  it("proposes whole days up to the target inside a read-only snapshot and writes nothing to the app", async () => {
    await enableAttendanceGroup(env.cp, { target: 3000 });
    const before = await appRows();
    const r = await collectApplication(env.cp, secrets, APP_ID, { now: NOW });
    expect(r.previews).toEqual([{ root: "public.attendance", status: "ready" }]);
    const p = (await env.cp.query(`SELECT preview FROM control.candidate_previews WHERE group_root = 'public.attendance'`)).rows[0].preview;
    expect(p.cutoffDay).toBe("2026-03-23"); // 2026-09-30 − 6 months − 7 days grace
    expect(p.oldestEligibleDate).toBe("2025-01-01");
    expect(p.totalBeforeFinalDay).toBeLessThan(3000);
    expect(p.candidateCount).toBeGreaterThanOrEqual(3000);
    expect(p.candidateCount).toBe(p.totalBeforeFinalDay + p.finalDayCount);
    expect(p.excluded.find((x: { reason: string }) => x.reason === "null_date").rows).toBe(5);
    expect(await appRows()).toBe(before);
  });

  it("never proposes a boundary when the target is not reached", async () => {
    await enableAttendanceGroup(env.cp, { target: 1_000_000 });
    await collectApplication(env.cp, secrets, APP_ID, { now: NOW });
    const row = (await env.cp.query(`SELECT status, preview FROM control.candidate_previews WHERE group_root = 'public.attendance'`)).rows[0];
    expect(row.status).toBe("target_not_reached");
    expect(row.preview.boundaryDate).toBeNull();
    expect(row.preview.candidateCount).toBe(0);
    expect(row.preview.excluded.map((x: { reason: string }) => x.reason)).toContain("target_not_reached");
  });

  it("is blocked when the configuration is incomplete (no grace period configured anywhere)", async () => {
    await enableAttendanceGroup(env.cp, { target: 3000, grace: null });
    await collectApplication(env.cp, secrets, APP_ID, { now: NOW });
    const row = (await env.cp.query(`SELECT status, preview FROM control.candidate_previews WHERE group_root = 'public.attendance'`)).rows[0];
    expect(row.status).toBe("blocked");
    expect(row.preview.blocking.join()).toMatch(/grace period is not configured/);
    expect(row.preview).toMatchObject({ tables: ["public.attendance", "public.attendance_notes"], dateColumn: "checked_in_at", target: 3000, cutoffDay: null, days: [] });
    await enableAttendanceGroup(env.cp, { target: 3000 });
  });

  it("FK graph: archiving the parent without its CASCADE child is blocked", async () => {
    const c = await openConnection(env.appConfig.connections.monitor!, secrets);
    try {
      const spec = { applicationId: APP_ID, root: "public.attendance", dateColumn: "checked_in_at", tables: ["public.attendance"], timeZone: TZ, cutoffDay: "2026-03-23", target: 3000 };
      const plan = await planGroup(c, spec);
      expect(plan.blocking.join()).toMatch(/unselected_child_cascade: attendance_notes_attendance_id_fkey/);
      expect((await previewCandidate(c, plan)).status).toBe("blocked");
      const ok = await planGroup(c, { ...spec, tables: ["public.attendance", "public.attendance_notes"] });
      expect(ok.blocking).toEqual([]);
      expect(ok.deleteOrder).toEqual(["public.attendance_notes", "public.attendance"]);
      expect(ok.warnings.join()).toMatch(/child_without_parent: attendance_member_id_fkey/); // members are not selected: fine
    } finally { await c.end(); }
  });
});

describe("live data-source adapter (browser → /api/infra → read-only control plane)", () => {
  it("ApiDataSource reads real control-plane data through the route handler and exposes no secrets", async () => {
    const route = await import("@/app/api/infra/[...path]/route");
    const { ApiDataSource } = await import("@/lib/data/api/apiDataSource");
    const seen: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const u = new URL(String(input), "http://localhost");
      const path = u.pathname.replace(/^\/api\/infra\//, "").split("/").map(decodeURIComponent);
      const res = init?.method && init.method !== "GET"
        ? await route.POST()
        : await route.GET(new NextRequest(u), { params: Promise.resolve({ path }) } as never);
      seen.push(await res.clone().text());
      return res;
    }) as typeof fetch;
    try {
      const ds = new ApiDataSource();
      const apps = await ds.listApplications();
      expect(apps.map((a) => a.id).sort()).toEqual(["synthetic-gym", "synthetic-offline"]);
      const tables = await ds.listTables(APP_ID);
      const att = tables.find((t) => t.tableName === "attendance")!;
      expect(att).toMatchObject({ rowCount: 6375, rowCountKind: "exact", avgDailyGrowth6m: 10, growthStatus: "measured", policy: "archive" });
      const ev = tables.find((t) => t.tableName === "app_events")!;
      expect(ev.avgDailyGrowth6m).toBeNull();
      expect(ev.projectedDaysToNextThreshold).toBeNull();
      const settings = await ds.getSettings();
      expect(settings.runtime).toMatchObject({ allowDeletion: false, deletionKillSwitch: true, notificationsEnabled: false, schedulingEnabled: false });
      const cands = await ds.listArchiveCandidates(APP_ID);
      expect(cands[0]!.readOnly).toBe(true);
      const health = await ds.getApplicationHealth(APP_ID);
      expect(health?.application.connectionStatus).toBe("connected");
      expect((await ds.listAuditLog(APP_ID)).some((e) => e.action === "table_discovered")).toBe(true);
      await expect(ds.updateSettings(settings)).rejects.toThrow(/READ-ONLY/);
      await expect(ds.simulateDeletionConfirmation("J-1")).rejects.toThrow(/READ-ONLY/);
      const all = seen.join("\n");
      expect(all).not.toMatch(/SYNTH_|env:|synthetic-local-only|prototype-local-only|password/i);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
