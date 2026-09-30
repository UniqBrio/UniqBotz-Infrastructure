import type pg from "pg";
import type { ApplicationConfig, DatabaseConnectionConfig, SecretRef } from "../connection/types";
import { validateApplicationConfig } from "../connection/types";
import type { RetentionPolicyRecord } from "../retention/policy";

export interface SystemSettingsRow {
  recordThresholds: { low: number; medium: number; high: number };
  capacityThresholdsPct: { low: number | null; medium: number | null; high: number | null; final: boolean };
  defaultArchiveTarget: number;
  defaultGracePeriodDays: number | null;
  deletionBatchSize: number;
  deletionKillSwitch: boolean;
  verificationMaxAgeMinutes: number;
  whatsappDestination: string | null;
  notificationsEnabled: boolean;
  schedulingEnabled: boolean;
  /** Approval-policy values. Every NULL is an undecided business rule → DELETION NOT AUTHORIZED. */
  approvalPolicy: {
    requiredApprovers: number | null;
    approvalValidityMinutes: number | null;
    excludesJobCreator: boolean | null;
    authorizationValidityMinutes: number | null;
    deletionWindow: { start: string; end: string; timeZone: string } | null;
  };
  killSwitchChangedBy: string | null;
  killSwitchChangedAt: string | null;
  updatedAt: string;
}

export async function loadSettings(cp: pg.Client | pg.PoolClient): Promise<SystemSettingsRow> {
  const r = (await cp.query(`SELECT * FROM control.system_settings WHERE id = 1`)).rows[0];
  return {
    recordThresholds: { low: Number(r.record_threshold_low), medium: Number(r.record_threshold_medium), high: Number(r.record_threshold_high) },
    capacityThresholdsPct: {
      low: r.capacity_threshold_low_pct === null ? null : Number(r.capacity_threshold_low_pct),
      medium: r.capacity_threshold_medium_pct === null ? null : Number(r.capacity_threshold_medium_pct),
      high: r.capacity_threshold_high_pct === null ? null : Number(r.capacity_threshold_high_pct),
      final: r.capacity_thresholds_final,
    },
    defaultArchiveTarget: r.default_archive_target,
    defaultGracePeriodDays: r.default_grace_period_days,
    deletionBatchSize: r.deletion_batch_size,
    deletionKillSwitch: r.deletion_kill_switch,
    verificationMaxAgeMinutes: r.verification_max_age_minutes,
    whatsappDestination: r.whatsapp_destination,
    notificationsEnabled: r.notifications_enabled,
    schedulingEnabled: r.scheduling_enabled,
    approvalPolicy: {
      requiredApprovers: r.approval_required_approvers ?? null,
      approvalValidityMinutes: r.approval_validity_minutes ?? null,
      excludesJobCreator: r.approval_excludes_job_creator ?? null,
      authorizationValidityMinutes: r.authorization_validity_minutes ?? null,
      deletionWindow: r.deletion_window_start && r.deletion_window_end && r.deletion_window_time_zone
        ? { start: String(r.deletion_window_start), end: String(r.deletion_window_end), timeZone: r.deletion_window_time_zone } : null,
    },
    killSwitchChangedBy: r.kill_switch_changed_by ?? null,
    killSwitchChangedAt: r.kill_switch_changed_at ? new Date(r.kill_switch_changed_at).toISOString() : null,
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

export async function registerApplication(cp: pg.Client, cfg: ApplicationConfig): Promise<void> {
  const errors = validateApplicationConfig(cfg);
  if (errors.length) throw new Error(`invalid application config: ${errors.join("; ")}`);
  await cp.query(
    `INSERT INTO control.applications (id, name, supabase_project_ref, environment, status, time_zone, enabled, monitoring_enabled, archive_enabled, database_capacity_mb)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, supabase_project_ref = EXCLUDED.supabase_project_ref, environment = EXCLUDED.environment,
       status = EXCLUDED.status, time_zone = EXCLUDED.time_zone, enabled = EXCLUDED.enabled, monitoring_enabled = EXCLUDED.monitoring_enabled,
       archive_enabled = EXCLUDED.archive_enabled, database_capacity_mb = EXCLUDED.database_capacity_mb, updated_at = now()`,
    [cfg.id, cfg.name, cfg.supabaseProjectRef, cfg.environment, cfg.status, cfg.timeZone, cfg.enabled, cfg.capabilities.monitoring, cfg.capabilities.archive, cfg.databaseCapacityMb],
  );
  for (const conn of Object.values(cfg.connections)) {
    if (!conn) continue;
    await cp.query(
      `INSERT INTO control.application_connections (application_id, purpose, host, port, database_name, username, password_secret_ref, ssl_mode, statement_timeout_ms, lock_timeout_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (application_id, purpose) DO UPDATE SET host = EXCLUDED.host, port = EXCLUDED.port, database_name = EXCLUDED.database_name,
         username = EXCLUDED.username, password_secret_ref = EXCLUDED.password_secret_ref, ssl_mode = EXCLUDED.ssl_mode,
         statement_timeout_ms = EXCLUDED.statement_timeout_ms, lock_timeout_ms = EXCLUDED.lock_timeout_ms, updated_at = now()`,
      [cfg.id, conn.purpose, conn.host, conn.port, conn.database, conn.user, conn.passwordRef, conn.sslMode, conn.statementTimeoutMs ?? null, conn.lockTimeoutMs ?? null],
    );
  }
}

export async function loadApplication(cp: pg.Client, id: string): Promise<ApplicationConfig> {
  const a = (await cp.query(`SELECT * FROM control.applications WHERE id = $1`, [id])).rows[0];
  if (!a) throw new Error(`unknown application ${id}`);
  const conns = (await cp.query(`SELECT * FROM control.application_connections WHERE application_id = $1`, [id])).rows;
  const connections: ApplicationConfig["connections"] = {};
  for (const c of conns) {
    connections[c.purpose as "monitor" | "archive"] = {
      purpose: c.purpose,
      host: c.host,
      port: c.port,
      database: c.database_name,
      user: c.username,
      passwordRef: c.password_secret_ref as SecretRef,
      sslMode: c.ssl_mode,
      statementTimeoutMs: c.statement_timeout_ms ?? undefined,
      lockTimeoutMs: c.lock_timeout_ms ?? undefined,
    } satisfies DatabaseConnectionConfig;
  }
  return {
    id: a.id,
    name: a.name,
    supabaseProjectRef: a.supabase_project_ref,
    environment: a.environment,
    status: a.status,
    timeZone: a.time_zone,
    enabled: a.enabled,
    capabilities: { monitoring: a.monitoring_enabled, archive: a.archive_enabled },
    databaseCapacityMb: a.database_capacity_mb,
    connections,
  };
}

function rowToPolicy(r: Record<string, unknown>): RetentionPolicyRecord {
  return {
    applicationId: r.application_id as string,
    schemaName: r.schema_name as string,
    tableName: r.table_name as string,
    policy: r.policy as RetentionPolicyRecord["policy"],
    dateColumn: (r.date_column as string) ?? null,
    protectedPeriodMonths: (r.protected_period_months as number) ?? null,
    targetRecords: (r.target_records as number) ?? null,
    gracePeriodDays: (r.grace_period_days as number) ?? null,
    archiveFormat: r.archive_format as "csv.gz",
    timeZone: (r.time_zone as string) ?? null,
    enabled: r.enabled as boolean,
    groupRoot: (r.group_root as string) ?? null,
    updatedBy: r.updated_by as string,
    updatedAt: new Date(r.updated_at as string).toISOString(),
  };
}

export async function listPolicies(cp: pg.Client, applicationId?: string): Promise<RetentionPolicyRecord[]> {
  const r = await cp.query(
    `SELECT * FROM control.retention_policies WHERE ($1::text IS NULL OR application_id = $1) ORDER BY application_id, schema_name, table_name`,
    [applicationId ?? null]);
  return r.rows.map(rowToPolicy);
}

/** Operator/CLI policy change (the web UI cannot write until authentication exists). */
export async function upsertPolicy(cp: pg.Client, p: RetentionPolicyRecord): Promise<void> {
  await cp.query(
    `INSERT INTO control.retention_policies (application_id, schema_name, table_name, policy, date_column, protected_period_months, target_records,
       grace_period_days, archive_format, time_zone, enabled, group_root, updated_by, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
     ON CONFLICT (application_id, schema_name, table_name) DO UPDATE SET policy = EXCLUDED.policy, date_column = EXCLUDED.date_column,
       protected_period_months = EXCLUDED.protected_period_months, target_records = EXCLUDED.target_records, grace_period_days = EXCLUDED.grace_period_days,
       archive_format = EXCLUDED.archive_format, time_zone = EXCLUDED.time_zone, enabled = EXCLUDED.enabled, group_root = EXCLUDED.group_root,
       updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [p.applicationId, p.schemaName, p.tableName, p.policy, p.dateColumn, p.protectedPeriodMonths, p.targetRecords, p.gracePeriodDays,
      p.archiveFormat, p.timeZone, p.enabled, p.groupRoot, p.updatedBy],
  );
}
