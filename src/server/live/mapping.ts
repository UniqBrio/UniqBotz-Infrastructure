/**
 * Pure mapping from control-plane rows to the Phase 1 UI contracts (InfrastructureDataSource types).
 * No database access and no secrets here — unit-testable. Connection details are NEVER mapped.
 */
import { classifyRecords, nextThreshold, projectDaysToThreshold } from "@/lib/domain/severity";
import type {
  Alert,
  Application,
  ArchiveCandidate,
  ArchiveJob,
  ArchiveJobStatus,
  AuditEntry,
  InfrastructureSettings,
  PipelineStep,
  PipelineStepStatus,
  RetentionPolicy,
  RetentionPolicyKind,
  TableHealth,
} from "@/lib/domain/types";

const MB = 1024 * 1024;
const NEW_TABLE_WINDOW_DAYS = 7;

export interface AppRow {
  id: string; name: string; supabase_project_ref: string | null; environment: string; time_zone: string;
  database_capacity_mb: number | null; connection_status: Application["connectionStatus"]; last_health_check_at: Date | string | null;
  database_bytes: string | number | null; created_at: Date | string; last_error: string | null;
}

export interface TableRow {
  application_id: string; schema_name: string; table_name: string; first_discovered_at: Date | string; last_seen_at: Date | string;
  primary_key: string[]; estimated_rows: string | number | null; exact_rows: string | number | null; table_bytes: string | number | null;
  index_bytes: string | number | null; dead_tuples: string | number | null; date_candidates: string[]; growth: GrowthJson | null; rls_enabled: boolean;
}

type GrowthJson =
  | { status: "measured"; avgPerDay: number; monthly: { month: string; recordsAdded: number; daysInMonth: number }[]; column: string; spikeDays: unknown[] }
  | { status: "insufficient_history"; reason: string };

export interface PolicyRow {
  application_id: string; schema_name: string; table_name: string; policy: "REVIEW_REQUIRED" | "DO_NOT_ARCHIVE" | "ARCHIVE";
  date_column: string | null; protected_period_months: number | null; target_records: number | null; enabled: boolean;
  updated_at: Date | string; updated_by: string; grace_period_days: number | null; group_root: string | null;
}

export interface SettingsRow {
  record_threshold_low: string | number; record_threshold_medium: string | number; record_threshold_high: string | number;
  capacity_threshold_low_pct: string | number | null; capacity_threshold_medium_pct: string | number | null; capacity_threshold_high_pct: string | number | null;
  capacity_thresholds_final: boolean; default_archive_target: number; default_grace_period_days: number | null; deletion_batch_size: number;
  deletion_kill_switch: boolean; whatsapp_destination: string | null; notifications_enabled: boolean; scheduling_enabled: boolean;
}

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const num = (v: string | number | null | undefined) => (v === null || v === undefined ? null : Number(v));
export const qualified = (schema: string, table: string) => (schema === "public" ? table : `${schema}.${table}`);

export const POLICY_KIND: Record<PolicyRow["policy"], RetentionPolicyKind> = {
  REVIEW_REQUIRED: "review_required",
  DO_NOT_ARCHIVE: "dont_archive",
  ARCHIVE: "archive",
};

export function mapApplication(r: AppRow): Application {
  return {
    id: r.id,
    name: r.name,
    description: `${r.environment === "synthetic" ? "Synthetic / local test application" : `Supabase project ${r.supabase_project_ref ?? "—"}`} · ${r.time_zone}`,
    supabaseProjectRef: r.supabase_project_ref ?? "—",
    region: "—",
    databaseSizeMb: Math.round(((num(r.database_bytes) ?? 0) / MB) * 10) / 10,
    databaseCapacityMb: r.database_capacity_mb ?? 0,
    connectionStatus: r.connection_status,
    lastHealthCheckAt: iso(r.last_health_check_at) ?? iso(r.created_at)!,
    registeredAt: iso(r.created_at)!,
  };
}

export function mapSettings(r: SettingsRow): InfrastructureSettings {
  return {
    recordThresholds: { low: Number(r.record_threshold_low), medium: Number(r.record_threshold_medium), high: Number(r.record_threshold_high) },
    capacityThresholdsPct: { low: num(r.capacity_threshold_low_pct) ?? 0, medium: num(r.capacity_threshold_medium_pct) ?? 0, high: num(r.capacity_threshold_high_pct) ?? 0 },
    capacityThresholdsFinal: r.capacity_thresholds_final,
    defaultArchiveTarget: r.default_archive_target,
    notifications: { whatsappNumber: r.whatsapp_destination ?? "", email: "", duplicateSuppressionHours: 24, notifyOnEscalation: false, notifyOnRecovery: false },
    safety: { gracePeriodDays: r.default_grace_period_days, archiveVerificationRequired: true, deletionBatchSize: r.deletion_batch_size, manualDeletionReviewRequired: true },
    archiveFormat: "csv.gz",
    newTableWindowDays: NEW_TABLE_WINDOW_DAYS,
    runtime: { allowDeletion: false, deletionKillSwitch: r.deletion_kill_switch, schedulingEnabled: r.scheduling_enabled, notificationsEnabled: r.notifications_enabled, policyEditing: "disabled_until_auth" },
  };
}

export function mapTable(t: TableRow, policy: PolicyRow | undefined, settings: InfrastructureSettings, now = new Date()): TableHealth {
  const exact = num(t.exact_rows);
  const rowCount = exact ?? num(t.estimated_rows) ?? 0;
  const thresholds = settings.recordThresholds;
  const next = nextThreshold(rowCount, thresholds);
  const remaining = next ? next.threshold - rowCount : null;
  const g = t.growth;
  const measured = g?.status === "measured" ? g : null;
  const ageDays = (now.getTime() - new Date(t.first_discovered_at).getTime()) / 86_400_000;
  return {
    applicationId: t.application_id,
    tableName: qualified(t.schema_name, t.table_name),
    schema: t.schema_name,
    rowCount,
    rowCountKind: exact !== null ? "exact" : "estimate",
    estimatedSizeMb: Math.round(((num(t.table_bytes) ?? 0) / MB) * 100) / 100,
    indexSizeMb: Math.round(((num(t.index_bytes) ?? 0) / MB) * 100) / 100,
    deadTuples: num(t.dead_tuples),
    dateColumns: t.date_candidates,
    monthlyGrowth: measured?.monthly ?? [],
    discoveredAt: iso(t.first_discovered_at)!,
    lastCheckedAt: iso(t.last_seen_at)!,
    severity: classifyRecords(rowCount, thresholds),
    avgDailyGrowth6m: measured ? measured.avgPerDay : null,
    growthStatus: measured ? "measured" : "insufficient_history",
    growthNote: measured ? `measured on ${measured.column}` : g?.status === "insufficient_history" ? g.reason : "not collected yet",
    nextThreshold: next,
    recordsRemaining: remaining,
    projectedDaysToNextThreshold: measured ? projectDaysToThreshold(remaining, measured.avgPerDay) : null,
    isNewlyDiscovered: ageDays <= NEW_TABLE_WINDOW_DAYS,
    policy: POLICY_KIND[policy?.policy ?? "REVIEW_REQUIRED"],
  };
}

export function mapPolicy(p: PolicyRow): RetentionPolicy {
  return {
    applicationId: p.application_id,
    tableName: qualified(p.schema_name, p.table_name),
    policy: POLICY_KIND[p.policy],
    dateColumn: p.date_column,
    protectedPeriodMonths: p.protected_period_months,
    archiveTargetRecords: p.target_records,
    enabled: p.enabled,
    updatedAt: iso(p.updated_at)!,
    updatedBy: p.updated_by,
  };
}

export interface PreviewRow {
  application_id: string; group_root: string; computed_at: Date | string; status: string;
  preview: {
    tables?: string[]; dateColumn?: string; target?: number; cutoffDay?: string; days?: ArchiveCandidate["days"];
    excluded?: { reason: string; rows: number; detail: string }[]; blocking?: string[];
  };
  protected_period_months: number | null;
  active_job_id: string | null;
  previous_boundary: string | null;
}

export function mapCandidate(r: PreviewRow): ArchiveCandidate {
  const p = r.preview;
  const root = r.group_root;
  const tables = p.tables ?? [root];
  const short = (t: string) => (t.startsWith("public.") ? t.slice(7) : t);
  return {
    id: `PREVIEW-${r.application_id}-${root}`,
    applicationId: r.application_id,
    tables: tables.map(short),
    dateColumnByTable: Object.fromEntries(tables.map((t) => [short(t), t === root ? (p.dateColumn ?? "—") : "(root day, via FK)"])),
    target: p.target ?? 0,
    protectedPeriodMonths: r.protected_period_months ?? 0,
    protectedFrom: p.cutoffDay ?? "—",
    days: (p.days ?? []).map((d) => ({ date: d.date, countsByTable: Object.fromEntries(Object.entries(d.countsByTable).map(([t, n]) => [short(t), n])) })),
    blockedByJobId: r.active_job_id,
    previousBoundary: r.previous_boundary,
    generatedAt: iso(r.computed_at)!,
    excluded: p.excluded ?? [],
    readOnly: true,
    blocking: p.blocking ?? [],
  };
}

export interface JobBundle {
  job: {
    id: string; application_id: string; group_root: string; tables: string[]; mode: string; status: string; attempt: number;
    spec: { target: number }; selection: { oldestDate?: string; boundaryDate?: string; totalSelected?: number; totalsByTable?: Record<string, number> } | null;
    created_at: Date | string; updated_at: Date | string; finished_at: Date | string | null; created_by: string; failure: unknown;
  };
  manifest: { store_uri: string; files: Record<string, { bytes: number }> } | null;
  verification: { verified: boolean; failed_stage: string | null; checks: { stage: string; name: string; pass: boolean; detail: string }[]; verified_at: Date | string } | null;
  batches: { state: string; deleted: number | null }[];
  candidateRows: number;
  rootRows: number;
  batchSize: number;
}

const STATUS_MAP: Record<string, ArchiveJobStatus> = {
  queued: "queued", preparing: "preparing", freezing: "selecting", exporting: "exporting", verifying: "verifying",
  ready_for_deletion: "ready_for_deletion", deletion_approved: "deletion_approved", deleting: "deleting",
  verifying_deletion: "verifying_deletion", waiting_retry: "waiting_retry", completed: "completed",
  completed_with_exceptions: "completed_with_exceptions", failed: "failed", cancelled: "cancelled", requires_review: "requires_review",
};
const PROGRESS: Record<string, number> = {
  queued: 0, preparing: 5, freezing: 15, exporting: 30, verifying: 50, ready_for_deletion: 60, deletion_approved: 62,
  deleting: 70, verifying_deletion: 95, waiting_retry: 0, completed: 100, completed_with_exceptions: 100, failed: 0, cancelled: 0, requires_review: 0,
};

export function mapJob(b: JobBundle): ArchiveJob {
  const j = b.job;
  const sel = j.selection ?? {};
  const status = STATUS_MAP[j.status] ?? "failed";
  const v = b.verification;
  const failedCheck = v?.checks.find((c) => !c.pass);
  const deleted = b.batches.reduce((s, x) => s + (x.deleted ?? 0), 0);
  const done = b.batches.filter((x) => x.state === "done").length;
  const total = b.rootRows ? Math.ceil(b.rootRows / b.batchSize) : 0;
  const deletionDisabled = j.mode === "ARCHIVE_AND_VERIFY_ONLY";
  const at = iso(j.updated_at);
  const step = (key: PipelineStep["key"], s: PipelineStepStatus, detail: string | null = null, error: string | null = null, recordCount: number | null = null): PipelineStep =>
    ({ key, status: s, at: s === "pending" ? null : at, recordCount, detail, error });
  const has = { selection: j.selection !== null, manifest: b.manifest !== null };
  const failedEarly = j.status === "failed" && !has.manifest;
  const steps: PipelineStep[] = [
    step("candidate_selection", has.selection ? "passed" : failedEarly ? "failed" : "pending", has.selection ? `Whole days ${sel.oldestDate} → ${sel.boundaryDate} (selected inside the freeze snapshot)` : null,
      failedEarly ? JSON.stringify(j.failure) : null, sel.totalSelected ?? null),
    step("candidate_frozen", has.manifest ? "passed" : "pending", has.manifest ? "Exact PK + row fingerprint set frozen in the control plane" : null, null, has.manifest ? b.candidateRows : null),
    step("archive_created", has.manifest ? "passed" : j.status === "exporting" ? "running" : "pending", has.manifest ? `CSV.GZ + manifest in ${b.manifest!.store_uri}` : null),
    step("archive_verified", v ? (v.verified ? "passed" : "failed") : j.status === "verifying" ? "running" : "pending",
      v?.verified ? "All 6 gate stages passed (incl. full restore + fingerprint reconciliation)" : null,
      v && !v.verified ? `${v.failed_stage}: ${failedCheck?.name} — ${failedCheck?.detail}` : null),
    step("deletion", v && !v.verified ? "blocked" : deletionDisabled && v?.verified ? "blocked" : j.status === "deleting" ? "running" : ["completed", "completed_with_exceptions"].includes(j.status) ? "passed" : j.status === "ready_for_deletion" || j.status === "deletion_approved" ? "awaiting_review" : "pending",
      deletionDisabled ? "ARCHIVE_AND_VERIFY_ONLY job — deletion is disabled (ALLOW_DELETION=false)" : null, null, deleted || null),
    step("deletion_verified", ["completed", "completed_with_exceptions"].includes(j.status) ? "passed" : "pending"),
    step("completed", ["completed", "completed_with_exceptions"].includes(j.status) ? "passed" : j.status === "failed" ? "failed" : "pending"),
  ];
  const dataBytes = b.manifest ? Object.entries(b.manifest.files).filter(([k]) => k.includes("/data/")).reduce((s, [, f]) => s + f.bytes, 0) : 0;
  const integrity = v?.checks.filter((c) => c.stage === "archive_integrity") ?? [];
  return {
    id: j.id,
    applicationId: j.application_id,
    tables: j.tables.map((t) => (t.startsWith("public.") ? t.slice(7) : t)),
    target: j.spec.target,
    selected: sel.totalSelected ?? 0,
    selectedByTable: sel.totalsByTable ?? {},
    status,
    progressPct: status === "deleting" && total ? Math.round(60 + (35 * done) / total) : PROGRESS[j.status] ?? 0,
    boundaryFrom: sel.oldestDate ?? "—",
    boundaryTo: sel.boundaryDate ?? "—",
    createdAt: iso(j.created_at)!,
    startedAt: iso(j.created_at)!,
    finishedAt: iso(j.finished_at),
    createdBy: j.created_by,
    archiveFormat: "csv.gz",
    archiveSizeMb: b.manifest ? Math.round((dataBytes / MB) * 100) / 100 : null,
    archiveLocation: b.manifest?.store_uri ?? null,
    verification: {
      state: v ? (v.verified ? "passed" : "failed") : j.status === "verifying" ? "running" : "pending",
      expectedCount: sel.totalSelected ?? 0,
      verifiedCount: v?.verified ? (sel.totalSelected ?? 0) : null,
      checksumMatch: integrity.length ? integrity.every((c) => c.pass) : null,
      error: v && !v.verified ? `${v.failed_stage}: ${failedCheck?.detail ?? "failed"}` : null,
      verifiedAt: iso(v?.verified_at),
    },
    deletion: {
      state: v && !v.verified ? "blocked" : deletionDisabled ? "blocked" : j.status === "deleting" ? "in_progress"
        : ["completed", "completed_with_exceptions"].includes(j.status) ? "completed" : j.status === "requires_review" && done > 0 ? "halted"
        : ["ready_for_deletion", "deletion_approved"].includes(j.status) ? "awaiting_review" : "not_started",
      deletedCount: deleted,
      batchSize: b.batchSize,
      batchesCompleted: done,
      batchesTotal: total,
    },
    steps,
  };
}

export interface AlertRow {
  id: string | number; application_id: string; kind: Alert["kind"]; schema_name: string | null; table_name: string | null; level: Alert["level"];
  state: Alert["state"]; observed_value: string | number; threshold: string | number; avg_daily_growth: string | number | null;
  escalated_from: Alert["level"] | null; detected_at: Date | string; resolved_at: Date | string | null;
}

export function mapAlert(r: AlertRow, whatsapp: string | null): Alert {
  return {
    id: `ALT-${r.id}`,
    applicationId: r.application_id,
    kind: r.kind,
    tableName: r.table_name ? qualified(r.schema_name ?? "public", r.table_name) : null,
    level: r.level,
    state: r.state,
    observedValue: Number(r.observed_value),
    threshold: Number(r.threshold),
    avgDailyGrowth: num(r.avg_daily_growth),
    detectedAt: iso(r.detected_at)!,
    resolvedAt: iso(r.resolved_at),
    escalatedFrom: r.escalated_from,
    notifications: [
      { channel: "whatsapp", destination: whatsapp ?? "—", status: "not_configured", at: null, detail: "Notifications are DISABLED in Phase 3B — nothing was sent." },
    ],
  };
}

export interface AuditRow {
  id: string | number; at: Date | string; application_id: string | null; job_id: string | null; action: string; table_name: string | null;
  actor_type: "user" | "system" | "worker"; actor_name: string; result: AuditEntry["result"]; detail: unknown;
}

export function mapAudit(r: AuditRow): AuditEntry {
  return {
    id: `AUD-${r.id}`,
    at: iso(r.at)!,
    applicationId: r.application_id,
    action: r.action as AuditEntry["action"],
    tableName: r.table_name,
    actor: { type: r.actor_type, name: r.actor_name },
    result: r.result,
    detail: r.detail === null || r.detail === undefined ? null : JSON.stringify(r.detail).slice(0, 400),
    jobId: r.job_id,
  };
}
