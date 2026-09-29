import { describe, expect, it } from "vitest";
import { averageDailyGrowth } from "@/lib/domain/health";
import { isDeletionAllowed } from "@/lib/domain/jobs";
import { selectWholeDays } from "@/lib/domain/selection";
import { seedArchiveCandidates } from "./archiveCandidates";
import { seedArchiveJobs } from "./archiveJobs";
import { MockDataSource } from "./mockDataSource";
import { seedRetentionPolicies } from "./retentionPolicies";
import { seedTables } from "./tables";

describe("mock data invariants", () => {
  it("defaults newly discovered tables to Review Required, never Archive", () => {
    const newTables = seedTables.filter((t) => ["trainer_feedback", "chat_messages", "delivery_partner_events"].includes(t.tableName));
    expect(newTables).toHaveLength(3);
    for (const t of newTables) {
      const p = seedRetentionPolicies.find((x) => x.applicationId === t.applicationId && x.tableName === t.tableName);
      expect(p?.policy).toBe("review_required");
      expect(p?.enabled).toBe(false);
    }
  });

  it("only enables tables whose policy is Archive", () => {
    for (const p of seedRetentionPolicies) if (p.enabled) expect(p.policy).toBe("archive");
  });

  it("never records deletions for a job whose verification did not pass", () => {
    for (const job of seedArchiveJobs) {
      if (!isDeletionAllowed(job)) {
        expect(job.deletion.deletedCount).toBe(0);
        expect(["ready_for_deletion", "deleting", "completed"]).not.toContain(job.status);
      }
    }
  });

  it("reproduces the documented candidate examples exactly", () => {
    const rosifit = seedArchiveCandidates.find((c) => c.applicationId === "rosifit")!;
    const r = selectWholeDays(rosifit.days, rosifit.target);
    expect([r.oldestDate, r.boundaryDate, r.totalBeforeFinalDay, r.finalDayCount, r.totalSelected]).toEqual([
      "2023-09-01",
      "2024-07-31",
      124_999,
      210,
      125_209,
    ]);
    const jalsa = seedArchiveCandidates.find((c) => c.applicationId === "jalsa")!;
    const j = selectWholeDays(jalsa.days, jalsa.target);
    expect([j.boundaryDate, j.totalBeforeFinalDay, j.finalDayCount, j.totalSelected]).toEqual(["2025-07-31", 124_999, 250, 125_249]);
  });

  it("gives attendance_records a 6-month average of exactly 1,240/day", () => {
    const t = seedTables.find((x) => x.tableName === "attendance_records")!;
    expect(t.monthlyGrowth).toHaveLength(6);
    expect(averageDailyGrowth(t.monthlyGrowth)).toBe(1_240);
  });
});

describe("MockDataSource safety", () => {
  it("refuses a simulated deletion when verification failed and deletes nothing", async () => {
    const src = new MockDataSource();
    src.simulation.latencyMs = 0;
    await expect(src.simulateDeletionConfirmation("JOB-00125")).rejects.toThrow(/0 records deleted/);
  });

  it("simulates (never performs) deletion for a verified job", async () => {
    const src = new MockDataSource();
    src.simulation.latencyMs = 0;
    const r = await src.simulateDeletionConfirmation("JOB-00126");
    expect(r.simulated).toBe(true);
    expect(r.recordsDeleted).toBe(0);
    const job = await src.getArchiveJob("JOB-00126");
    expect(job?.deletion.deletedCount).toBe(0);
  });

  it("rejects an Archive policy without a date column", async () => {
    const src = new MockDataSource();
    src.simulation.latencyMs = 0;
    await expect(
      src.saveRetentionPolicy({
        applicationId: "rosifit",
        tableName: "trainer_feedback",
        policy: "archive",
        dateColumn: null,
        protectedPeriodMonths: 12,
        archiveTargetRecords: 125_000,
        enabled: true,
      }),
    ).rejects.toThrow();
  });
});
