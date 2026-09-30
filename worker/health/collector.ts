import type pg from "pg";
import { audit } from "../audit/audit";
import { openConnection } from "../connection/connect";
import { classifyError } from "../connection/errors";
import type { SecretResolver } from "../connection/secrets";
import { exactRowCount, discoverDatabase, type DiscoveryResult } from "../discovery/catalog";
import { listPolicies, loadApplication, loadSettings } from "../controlplane/repository";
import { previewCandidate } from "../candidates/preview";
import { eligibilityCutoffDay, localToday, planGroup } from "../retention/group";
import { validatePolicy, type RetentionPolicyRecord } from "../retention/policy";
import { measureGrowth, type GrowthResult } from "./growth";

/**
 * READ-ONLY health collection for one application (manual trigger — no scheduler in Phase 3B).
 * Uses the MONITOR connection (session default_transaction_read_only = on). Writes only to the control plane.
 */
export interface CollectOptions {
  /** Exact counts for tables up to this estimate, or within ±5 % of a threshold. */
  exactCountMaxRows?: number;
  now?: Date;
}

export interface CollectResult {
  applicationId: string;
  ok: boolean;
  error?: string;
  tables: number;
  newTables: string[];
  previews: { root: string; status: string }[];
}

function near(n: number, thresholds: number[]) {
  return thresholds.some((t) => Math.abs(n - t) <= t * 0.05);
}

export async function collectApplication(cp: pg.Client, secrets: SecretResolver, applicationId: string, opts: CollectOptions = {}): Promise<CollectResult> {
  const app = await loadApplication(cp, applicationId);
  const settings = await loadSettings(cp);
  const conn = app.connections.monitor;
  if (!app.enabled || !app.capabilities.monitoring || !conn) {
    await cp.query(`UPDATE control.applications SET connection_status = 'not_configured', updated_at = now() WHERE id = $1`, [applicationId]);
    return { applicationId, ok: false, error: "monitoring not configured", tables: 0, newTables: [], previews: [] };
  }
  let c: pg.Client | null = null;
  try {
    c = await openConnection(conn, secrets, { applicationName: "uniqbotz-monitor" });
    const disc = await discoverDatabase(c);
    const today = localToday(app.timeZone, opts.now);
    const newTables = await persistDiscovery(cp, applicationId, disc);

    const t = settings.recordThresholds;
    // RLS hides rows from a role that cannot bypass it (Phase 3A P9): counting through it would understate the
    // table, so such tables keep the planner estimate and report growth as INSUFFICIENT HISTORY.
    const role = (await c.query(`SELECT rolbypassrls OR rolsuper AS bypass FROM pg_roles WHERE rolname = current_user`)).rows[0];
    const bypassRls = Boolean(role?.bypass);
    for (const tbl of disc.tables) {
      const rlsBlind = tbl.rls.enabled && !bypassRls;
      let exact: number | null = null;
      if (!rlsBlind && (tbl.estimatedRows <= (opts.exactCountMaxRows ?? 200_000) || near(tbl.estimatedRows, [t.low, t.medium, t.high]))) {
        exact = await exactRowCount(c, tbl.qualified);
      }
      let growth: GrowthResult;
      try {
        growth = rlsBlind
          ? { status: "insufficient_history", reason: "row-level security hides rows from the monitor role — counts are planner estimates", column: tbl.insertionColumn, timeZone: app.timeZone, computedAt: new Date().toISOString() }
          : await measureGrowth(c, tbl.qualified, tbl.insertionColumn, app.timeZone, today);
      } catch (e) {
        growth = { status: "insufficient_history", reason: `growth query failed: ${(e as Error).message}`, column: tbl.insertionColumn, timeZone: app.timeZone, computedAt: new Date().toISOString() };
      }
      await cp.query(
        `UPDATE control.discovered_tables SET exact_rows = $4, exact_rows_at = CASE WHEN $4::bigint IS NULL THEN exact_rows_at ELSE now() END, growth = $5
         WHERE application_id = $1 AND schema_name = $2 AND table_name = $3`,
        [applicationId, tbl.schema, tbl.name, exact, JSON.stringify(growth)]);
      await cp.query(
        `INSERT INTO control.table_stats_snapshots (application_id, schema_name, table_name, captured_on, estimated_rows, exact_rows, total_bytes, index_bytes, dead_tuples)
         VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8,$9)
         ON CONFLICT (application_id, schema_name, table_name, captured_on) DO UPDATE SET captured_at = now(), estimated_rows = EXCLUDED.estimated_rows,
           exact_rows = coalesce(EXCLUDED.exact_rows, control.table_stats_snapshots.exact_rows), total_bytes = EXCLUDED.total_bytes,
           index_bytes = EXCLUDED.index_bytes, dead_tuples = EXCLUDED.dead_tuples`,
        [applicationId, tbl.schema, tbl.name, today, tbl.estimatedRows, exact, tbl.totalBytes, tbl.indexBytes, tbl.deadTuples]);
      await evaluateRecordAlert(cp, applicationId, tbl.schema, tbl.name, exact ?? tbl.estimatedRows, t, growth.status === "measured" ? growth.avgPerDay : null);
    }
    await cp.query(
      `INSERT INTO control.database_stats_snapshots (application_id, captured_on, database_bytes) VALUES ($1, $2::date, $3)
       ON CONFLICT (application_id, captured_on) DO UPDATE SET database_bytes = EXCLUDED.database_bytes, captured_at = now()`,
      [applicationId, today, disc.databaseBytes]);
    await evaluateCapacityAlert(cp, applicationId, disc.databaseBytes, app.databaseCapacityMb, settings.capacityThresholdsPct);

    const previews = await refreshPreviews(cp, c, app.id, app.timeZone, today, settings.defaultGracePeriodDays, disc);
    await cp.query(
      `UPDATE control.applications SET connection_status = 'connected', last_health_check_at = now(), last_error = NULL,
         database_bytes = $2, server_version = $3, updated_at = now() WHERE id = $1`,
      [applicationId, disc.databaseBytes, disc.serverVersion]);
    await audit(cp, { action: "health_collected", result: "success", applicationId, detail: { tables: disc.tables.length, newTables, databaseBytes: disc.databaseBytes } });
    return { applicationId, ok: true, tables: disc.tables.length, newTables, previews };
  } catch (e) {
    const kind = classifyError(e);
    await cp.query(
      `UPDATE control.applications SET connection_status = $2, last_error = $3, updated_at = now() WHERE id = $1`,
      [applicationId, kind === "transient" || kind === "auth" ? "disconnected" : "degraded", String((e as Error).message).slice(0, 500)]);
    await audit(cp, { action: "collection_failed", result: "failure", applicationId, detail: { kind, message: String((e as Error).message) } });
    return { applicationId, ok: false, error: `${kind}: ${(e as Error).message}`, tables: 0, newTables: [], previews: [] };
  } finally {
    await c?.end().catch(() => {});
  }
}

async function persistDiscovery(cp: pg.Client, applicationId: string, disc: DiscoveryResult): Promise<string[]> {
  const existing = new Set((await cp.query(`SELECT schema_name || '.' || table_name AS q FROM control.discovered_tables WHERE application_id = $1`, [applicationId])).rows.map((r) => r.q as string));
  const newTables: string[] = [];
  for (const t of disc.tables) {
    const isNew = !existing.has(t.qualified);
    await cp.query(
      `INSERT INTO control.discovered_tables (application_id, schema_name, table_name, primary_key, rls_enabled, rls_forced, estimated_rows,
         table_bytes, index_bytes, total_bytes, dead_tuples, last_autovacuum, date_candidates, insertion_column, indexes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (application_id, schema_name, table_name) DO UPDATE SET last_seen_at = now(), is_present = true, primary_key = EXCLUDED.primary_key,
         rls_enabled = EXCLUDED.rls_enabled, rls_forced = EXCLUDED.rls_forced, estimated_rows = EXCLUDED.estimated_rows, table_bytes = EXCLUDED.table_bytes,
         index_bytes = EXCLUDED.index_bytes, total_bytes = EXCLUDED.total_bytes, dead_tuples = EXCLUDED.dead_tuples, last_autovacuum = EXCLUDED.last_autovacuum,
         date_candidates = EXCLUDED.date_candidates, insertion_column = EXCLUDED.insertion_column, indexes = EXCLUDED.indexes`,
      [applicationId, t.schema, t.name, t.primaryKey, t.rls.enabled, t.rls.forced, t.estimatedRows, t.tableBytes, t.indexBytes, t.totalBytes,
        t.deadTuples, t.lastAutovacuum, t.dateCandidates, t.insertionColumn, JSON.stringify(t.indexes)]);
    await cp.query(`DELETE FROM control.table_columns WHERE application_id = $1 AND schema_name = $2 AND table_name = $3`, [applicationId, t.schema, t.name]);
    for (const col of t.columns) {
      await cp.query(
        `INSERT INTO control.table_columns (application_id, schema_name, table_name, column_name, ordinal, data_type, is_nullable, default_expr, is_date_candidate)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [applicationId, t.schema, t.name, col.name, col.ordinal, col.type, col.nullable, col.default, col.isDateCandidate]);
    }
    if (isNew) {
      newTables.push(t.qualified);
      // NEW TABLES ARE NEVER ARCHIVABLE BY DEFAULT
      const ins = await cp.query(
        `INSERT INTO control.retention_policies (application_id, schema_name, table_name) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [applicationId, t.schema, t.name]);
      await audit(cp, { action: "table_discovered", result: "info", applicationId, tableName: t.qualified, detail: { primaryKey: t.primaryKey, dateCandidates: t.dateCandidates } });
      if (ins.rowCount) await audit(cp, { action: "policy_defaulted", result: "info", applicationId, tableName: t.qualified, detail: { policy: "REVIEW_REQUIRED" } });
    }
  }
  const present = disc.tables.map((t) => t.qualified);
  await cp.query(`UPDATE control.discovered_tables SET is_present = false WHERE application_id = $1 AND NOT (schema_name || '.' || table_name = ANY($2::text[]))`, [applicationId, present]);
  await cp.query(`DELETE FROM control.foreign_keys WHERE application_id = $1`, [applicationId]);
  for (const e of disc.foreignKeys) {
    await cp.query(
      `INSERT INTO control.foreign_keys (application_id, constraint_name, child_table, child_columns, parent_table, parent_columns, on_delete)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [applicationId, e.name, e.child, e.childColumns, e.parent, e.parentColumns, e.onDelete]);
  }
  await audit(cp, { action: "discovery_completed", result: "success", applicationId, detail: { tables: disc.tables.length, foreignKeys: disc.foreignKeys.length } });
  return newTables;
}

type Level = "LOW" | "MEDIUM" | "HIGH";
function levelFor(n: number, t: { low: number; medium: number; high: number }): Level | null {
  return n >= t.high ? "HIGH" : n >= t.medium ? "MEDIUM" : n >= t.low ? "LOW" : null;
}

async function upsertAlert(cp: pg.Client, applicationId: string, kind: string, schema: string | null, table: string | null, level: Level | null, observed: number, threshold: number, growth: number | null) {
  const active = (await cp.query(
    `SELECT id, level FROM control.alerts WHERE application_id = $1 AND kind = $2 AND coalesce(schema_name,'') = coalesce($3,'') AND coalesce(table_name,'') = coalesce($4,'') AND state = 'active'`,
    [applicationId, kind, schema, table])).rows[0];
  if (!level) {
    if (active) await cp.query(`UPDATE control.alerts SET state = 'resolved', resolved_at = now() WHERE id = $1`, [active.id]);
    return;
  }
  if (active && active.level === level) {
    await cp.query(`UPDATE control.alerts SET observed_value = $2, avg_daily_growth = $3 WHERE id = $1`, [active.id, observed, growth]);
    return;
  }
  if (active) await cp.query(`UPDATE control.alerts SET state = 'resolved', resolved_at = now() WHERE id = $1`, [active.id]);
  await cp.query(
    `INSERT INTO control.alerts (application_id, kind, schema_name, table_name, level, observed_value, threshold, avg_daily_growth, escalated_from)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [applicationId, kind, schema, table, level, observed, threshold, growth, active?.level ?? null]);
}

async function evaluateRecordAlert(cp: pg.Client, applicationId: string, schema: string, table: string, rows: number, t: { low: number; medium: number; high: number }, growth: number | null) {
  const level = levelFor(rows, t);
  const threshold = level === "HIGH" ? t.high : level === "MEDIUM" ? t.medium : t.low;
  await upsertAlert(cp, applicationId, "table_records", schema, table, level, rows, threshold, growth);
}

async function evaluateCapacityAlert(cp: pg.Client, applicationId: string, bytes: number, capacityMb: number | null, c: { low: number | null; medium: number | null; high: number | null }) {
  if (!capacityMb || c.low === null || c.medium === null || c.high === null) return;
  const pct = (bytes / 1048576 / capacityMb) * 100;
  const level: Level | null = pct >= c.high ? "HIGH" : pct >= c.medium ? "MEDIUM" : pct >= c.low ? "LOW" : null;
  const thrPct = level === "HIGH" ? c.high : level === "MEDIUM" ? c.medium : c.low;
  await upsertAlert(cp, applicationId, "database_capacity", null, null, level, Math.round(bytes / 1048576), Math.round((capacityMb * thrPct) / 100), null);
}

async function refreshPreviews(cp: pg.Client, c: pg.Client, applicationId: string, appTz: string, today: string, defaultGrace: number | null, disc: DiscoveryResult) {
  const policies = await listPolicies(cp, applicationId);
  const roots = policies.filter((p) => p.policy === "ARCHIVE" && p.enabled && (p.groupRoot === null || p.groupRoot === `${p.schemaName}.${p.tableName}`));
  const out: { root: string; status: string }[] = [];
  for (const root of roots) {
    const rootQ = `${root.schemaName}.${root.tableName}`;
    const members = policies.filter((p) => p.groupRoot === rootQ && `${p.schemaName}.${p.tableName}` !== rootQ);
    const tbl = disc.tables.find((t) => t.qualified === rootQ);
    const errors = tbl ? validatePolicy(root, { columns: tbl.columns, hasPrimaryKey: tbl.primaryKey.length > 0, defaultGracePeriodDays: defaultGrace }) : ["table no longer present"];
    const nonArchiveMember = members.filter((m) => m.policy !== "ARCHIVE" || !m.enabled).map((m) => `${m.schemaName}.${m.tableName}: group member is not an enabled ARCHIVE policy`);
    let preview;
    if (errors.length || nonArchiveMember.length) {
      const grace = root.gracePeriodDays ?? defaultGrace;
      preview = {
        applicationId, root: rootQ, status: "blocked", blocking: [...errors, ...nonArchiveMember], computedAt: new Date().toISOString(),
        tables: [rootQ, ...members.map((m) => `${m.schemaName}.${m.tableName}`)], dateColumn: root.dateColumn, target: root.targetRecords,
        timeZone: root.timeZone ?? appTz,
        cutoffDay: grace !== null && root.protectedPeriodMonths ? eligibilityCutoffDay(today, root.protectedPeriodMonths, grace) : null,
        days: [], excluded: [],
      };
    } else {
      const grace = root.gracePeriodDays ?? defaultGrace!;
      const plan = await planGroup(c, {
        applicationId, root: rootQ, dateColumn: root.dateColumn!, tables: [rootQ, ...members.map((m) => `${m.schemaName}.${m.tableName}`)],
        timeZone: root.timeZone ?? appTz, cutoffDay: eligibilityCutoffDay(today, root.protectedPeriodMonths!, grace), target: root.targetRecords!,
      });
      preview = await previewCandidate(c, plan);
    }
    await cp.query(
      `INSERT INTO control.candidate_previews (application_id, group_root, status, preview) VALUES ($1,$2,$3,$4)
       ON CONFLICT (application_id, group_root) DO UPDATE SET status = EXCLUDED.status, preview = EXCLUDED.preview, computed_at = now()`,
      [applicationId, rootQ, preview.status, JSON.stringify(preview)]);
    await audit(cp, { action: "candidate_preview", result: "info", applicationId, tableName: rootQ, detail: { status: preview.status, readOnly: true } });
    out.push({ root: rootQ, status: preview.status });
  }
  return out;
}

export type { RetentionPolicyRecord };
