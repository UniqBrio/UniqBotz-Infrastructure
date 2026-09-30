import { describe, expect, it } from "vitest";
import { redact, WorkerLogger } from "../../observability/logger";
import { buildMessage, DisabledChannel, NOTIFICATION_EVENTS } from "../../notifications/notifications";
import { DisabledScheduler, evaluateScheduleEligibility } from "../../scheduling/scheduler";

describe("structured logging never leaks secrets or row data", () => {
  it("redacts connection-string passwords, JWTs, Supabase keys and key=value secrets", () => {
    const s = redact("connect postgres://uniqbotz_monitor:S3cr3t!@db.x.supabase.co:5432/postgres failed; token=abc123 password: hunter2 " +
      "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLXNpZ25hdHVyZQ sb_secret_ABCdef123456 apikey=zzz");
    for (const leaked of ["S3cr3t!", "abc123", "hunter2", "eyJhbGciOiJIUzI1NiJ9", "sb_secret_ABCdef123456", "zzz"]) expect(s).not.toContain(leaked);
    expect(s).toContain("uniqbotz_monitor:[REDACTED]@");
  });
  it("emits only allow-listed fields as one JSON line; unknown fields (e.g. a row) are dropped", () => {
    const lines: string[] = [];
    const log = new WorkerLogger((l) => lines.push(l)).child({ worker: "w1" });
    log.info("deletion_batch_completed", { application: "synthetic-gym", jobId: "J1", table: "public.attendance", phase: "deleting", batch: 3, rows: 2000, durationMs: 41,
      retry: 0, archiveObject: "a/b/manifest.json", checksum: "abc", row: { name: "A Person", phone: "+910000000000" } } as never);
    log.error("failed", { error: Object.assign(new Error("password=hunter2 rejected"), { code: "28P01" }) });
    const rec = JSON.parse(lines[0]!);
    expect(rec).toMatchObject({ level: "info", event: "deletion_batch_completed", worker: "w1", application: "synthetic-gym", jobId: "J1", batch: 3, rows: 2000, durationMs: 41, checksum: "abc" });
    expect(lines[0]).not.toContain("A Person");
    expect(lines[0]).not.toContain("+910000000000");
    expect(JSON.parse(lines[1]!).error).toBe("Error(28P01): password=[REDACTED] rejected");
  });
});

describe("notifications are prepared but disabled", () => {
  it("covers every required event and never delivers", async () => {
    expect(NOTIFICATION_EVENTS).toEqual(["threshold_alert", "archive_started", "archive_verified", "deletion_approved", "deletion_completed", "failure", "recovery", "database_critical"]);
    const r = await new DisabledChannel("whatsapp").send();
    expect(r.delivered).toBe(false);
    expect(r.reason).toMatch(/NOTIFICATIONS DISABLED/);
  });
  it("refuses message facts that could carry personal data or secrets", () => {
    expect(() => buildMessage("failure", "app", { phone: "x" })).toThrow(/not allowed/);
    expect(() => buildMessage("failure", "app", { apiKey: "x" })).toThrow(/not allowed/);
    expect(buildMessage("threshold_alert", "app", { level: "HIGH", rows: 1_200_001 }).summary).toBe("[threshold_alert] app: level=HIGH, rows=1200001");
  });
});

describe("scheduling is prepared but disabled", () => {
  it("lists every missing precondition", () => {
    const r = evaluateScheduleEligibility({ schedulingEnabled: false, policy: null, gracePeriodDays: null, applicationTimeZone: null, archiveStorageAvailable: false,
      previousVerification: "none", activeConflictingJob: "J-9", capacityLevel: "UNKNOWN", credentialsValid: false });
    expect(r.eligible).toBe(false);
    expect(r.reasons).toEqual(expect.arrayContaining(["SCHEDULING DISABLED", "GRACE PERIOD NOT CONFIGURED", "APPLICATION TIMEZONE NOT CONFIGURED", "ARCHIVE EXECUTION UNAVAILABLE", "active job J-9 for this group"]));
  });
  it("is still refused when everything else is ready, because scheduling is disabled", () => {
    const r = evaluateScheduleEligibility({ schedulingEnabled: false, policy: { policy: "ARCHIVE", enabled: true, dateColumn: "d", protectedPeriodMonths: 6, targetRecords: 1 },
      gracePeriodDays: 7, applicationTimeZone: "Asia/Kolkata", archiveStorageAvailable: true, previousVerification: "passed", activeConflictingJob: null, capacityLevel: "NONE", credentialsValid: true });
    expect(r).toEqual({ eligible: false, reasons: ["SCHEDULING DISABLED"] });
    expect(() => new DisabledScheduler().start()).toThrow(/SCHEDULING DISABLED/);
  });
});
