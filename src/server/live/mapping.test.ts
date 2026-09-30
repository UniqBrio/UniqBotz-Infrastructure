import { describe, expect, it } from "vitest";
import { mapAlert, mapCandidate, mapJob, mapSettings, mapTable, type JobBundle, type SettingsRow, type TableRow } from "./mapping";

const settingsRow: SettingsRow = {
  record_threshold_low: "1000000", record_threshold_medium: "1100000", record_threshold_high: "1200000",
  capacity_threshold_low_pct: "70", capacity_threshold_medium_pct: "80", capacity_threshold_high_pct: "90", capacity_thresholds_final: false,
  default_archive_target: 125000, default_grace_period_days: null, deletion_batch_size: 2000, deletion_kill_switch: true,
  whatsapp_destination: null, notifications_enabled: false, scheduling_enabled: false,
};

describe("live mapping (control plane → Phase 1 UI contracts)", () => {
  it("settings: deletion, scheduling and notifications are reported disabled; grace period stays unset", () => {
    const s = mapSettings(settingsRow);
    expect(s.recordThresholds).toEqual({ low: 1_000_000, medium: 1_100_000, high: 1_200_000 });
    expect(s.capacityThresholdsFinal).toBe(false);
    expect(s.safety.gracePeriodDays).toBeNull();
    expect(s.runtime).toEqual({ allowDeletion: false, deletionKillSwitch: true, schedulingEnabled: false, notificationsEnabled: false, policyEditing: "disabled_until_auth" });
  });

  const table = (growth: TableRow["growth"], exact: number | null): TableRow => ({
    application_id: "app", schema_name: "public", table_name: "attendance", first_discovered_at: "2026-09-01T00:00:00Z", last_seen_at: "2026-09-30T00:00:00Z",
    primary_key: ["id"], estimated_rows: "1049000", exact_rows: exact, table_bytes: 1048576, index_bytes: 0, dead_tuples: 10, date_candidates: ["checked_in_at"],
    growth, rls_enabled: false,
  });

  it("tables: INSUFFICIENT HISTORY yields no growth rate and no projection; estimates are labelled", () => {
    const t = mapTable(table({ status: "insufficient_history", reason: "no insertion timestamp" }, null), undefined, mapSettings(settingsRow), new Date("2026-09-30T00:00:00Z"));
    expect(t.avgDailyGrowth6m).toBeNull();
    expect(t.projectedDaysToNextThreshold).toBeNull();
    expect(t.growthStatus).toBe("insufficient_history");
    expect(t.growthNote).toBe("no insertion timestamp");
    expect(t.rowCountKind).toBe("estimate");
    expect(t.severity).toBe("LOW");
    expect(t.policy).toBe("review_required");
  });

  it("tables: measured growth projects to the next threshold; exact counts win over estimates", () => {
    const t = mapTable(table({ status: "measured", avgPerDay: 1000, monthly: [], column: "created_at", spikeDays: [] }, 1_050_000), undefined, mapSettings(settingsRow));
    expect(t.rowCountKind).toBe("exact");
    expect(t.recordsRemaining).toBe(50_000);
    expect(t.projectedDaysToNextThreshold).toBe(50);
  });

  it("candidates are read-only previews and carry blocking reasons", () => {
    const c = mapCandidate({ application_id: "app", group_root: "public.attendance", computed_at: "2026-09-30T00:00:00Z", status: "blocked",
      preview: { tables: ["public.attendance"], blocking: ["rls_hides_rows: public.attendance"] }, protected_period_months: 6, active_job_id: null, previous_boundary: null });
    expect(c.readOnly).toBe(true);
    expect(c.blocking).toEqual(["rls_hides_rows: public.attendance"]);
    expect(c.tables).toEqual(["attendance"]);
  });

  const bundle = (patch: Partial<JobBundle["job"]>, verified: boolean | null): JobBundle => ({
    job: { id: "J1", application_id: "app", group_root: "public.attendance", tables: ["public.attendance"], mode: "ARCHIVE_AND_VERIFY_ONLY", status: "ready_for_deletion",
      attempt: 1, spec: { target: 3000 }, selection: { oldestDate: "2025-01-01", boundaryDate: "2025-05-30", totalSelected: 3010, totalsByTable: { "public.attendance": 3010 } },
      created_at: "2026-09-30T00:00:00Z", updated_at: "2026-09-30T00:01:00Z", finished_at: null, created_by: "cli", failure: null, ...patch },
    manifest: { store_uri: "file:///x", files: { "a/data/x.csv.gz": { bytes: 1024 } } },
    verification: verified === null ? null : { verified, failed_stage: verified ? null : "restore_fingerprint", checks: [{ stage: "restore_fingerprint", name: "fp", pass: verified, detail: "3 mismatched" }], verified_at: "2026-09-30T00:01:00Z" },
    batches: [], candidateRows: 3010, rootRows: 3010, batchSize: 2000,
  });

  it("jobs: verify-only jobs show deletion BLOCKED with 0 deleted", () => {
    const j = mapJob(bundle({}, true));
    expect(j.status).toBe("ready_for_deletion");
    expect(j.verification.state).toBe("passed");
    expect(j.deletion.state).toBe("blocked");
    expect(j.deletion.deletedCount).toBe(0);
    expect(j.steps.find((s) => s.key === "deletion")!.detail).toMatch(/ALLOW_DELETION=false/);
  });

  it("jobs: failed verification blocks deletion and surfaces the failed stage", () => {
    const j = mapJob(bundle({ status: "failed" }, false));
    expect(j.verification.error).toMatch(/restore_fingerprint/);
    expect(j.deletion.state).toBe("blocked");
  });

  it("alerts never claim a notification was sent", () => {
    const a = mapAlert({ id: 1, application_id: "app", kind: "table_records", schema_name: "public", table_name: "attendance", level: "LOW", state: "active",
      observed_value: "1000001", threshold: "1000000", avg_daily_growth: null, escalated_from: null, detected_at: "2026-09-30T00:00:00Z", resolved_at: null }, "+910000000000");
    expect(a.notifications.every((n) => n.status === "not_configured" && n.at === null)).toBe(true);
  });
});

describe("deletion is never presented as allowed for a verify-only job", () => {
  it("isDeletionAllowed is false when the live deletion state is blocked", async () => {
    const { isDeletionAllowed } = await import("@/lib/domain/jobs");
    const j = mapJob({
      job: { id: "J1", application_id: "app", group_root: "public.t", tables: ["public.t"], mode: "ARCHIVE_AND_VERIFY_ONLY", status: "ready_for_deletion", attempt: 1,
        spec: { target: 10 }, selection: { totalSelected: 10 }, created_at: "2026-09-30T00:00:00Z", updated_at: "2026-09-30T00:00:00Z", finished_at: null, created_by: "cli", failure: null },
      manifest: { store_uri: "file:///x", files: {} },
      verification: { verified: true, failed_stage: null, checks: [{ stage: "archive_integrity", name: "sha", pass: true, detail: "ok" }], verified_at: "2026-09-30T00:00:00Z" },
      batches: [], candidateRows: 10, rootRows: 10, batchSize: 2000,
    });
    expect(j.verification.state).toBe("passed");
    expect(isDeletionAllowed(j)).toBe(false);
  });
});
