import { describe, expect, it } from "vitest";
import { defaultPolicy, policyStatus, validatePolicy, type RetentionPolicyRecord } from "../../retention/policy";
import { eligibilityCutoffDay, localToday } from "../../retention/group";

const ctx = { columns: [{ name: "checked_in_at", type: "timestamp with time zone" }, { name: "note", type: "text" }], hasPrimaryKey: true, defaultGracePeriodDays: null, applicationTimeZone: "Asia/Kolkata" as string | null };
const archive = (patch: Partial<RetentionPolicyRecord> = {}): RetentionPolicyRecord => ({
  ...defaultPolicy("app", "public", "attendance", "2026-09-30T00:00:00Z"),
  policy: "ARCHIVE", dateColumn: "checked_in_at", protectedPeriodMonths: 6, targetRecords: 3000, gracePeriodDays: 7, ...patch,
});

describe("retention policy — newly discovered tables are REVIEW_REQUIRED", () => {
  it("default policy is REVIEW_REQUIRED, disabled, with no grace period", () => {
    const p = defaultPolicy("app", "public", "new_table");
    expect(p).toMatchObject({ policy: "REVIEW_REQUIRED", enabled: false, gracePeriodDays: null, dateColumn: null, updatedBy: "system:discovery" });
  });

  it("only ARCHIVE policies can be enabled", () => {
    expect(validatePolicy({ ...defaultPolicy("a", "public", "t"), enabled: true }, ctx)).toContain("only ARCHIVE policies can be enabled");
    expect(validatePolicy({ ...defaultPolicy("a", "public", "t"), policy: "DO_NOT_ARCHIVE", enabled: true }, ctx)).toContain("only ARCHIVE policies can be enabled");
  });

  it("an ARCHIVE policy needs a temporal date column, a PK, a protected period, a target and a CONFIGURED grace period", () => {
    expect(validatePolicy(archive(), ctx)).toEqual([]);
    expect(validatePolicy(archive({ dateColumn: "note" }), ctx).join()).toMatch(/not a date\/timestamp/);
    expect(validatePolicy(archive({ dateColumn: "nope" }), ctx).join()).toMatch(/does not exist/);
    expect(validatePolicy(archive(), { ...ctx, hasPrimaryKey: false }).join()).toMatch(/no primary key/);
    expect(validatePolicy(archive({ protectedPeriodMonths: 0 }), ctx).join()).toMatch(/protected period/);
    expect(validatePolicy(archive({ targetRecords: null }), ctx).join()).toMatch(/CANNOT RUN — ARCHIVE TARGET NOT CONFIGURED/);
    expect(validatePolicy(archive({ gracePeriodDays: null }), ctx).join()).toMatch(/CANNOT RUN — GRACE PERIOD NOT CONFIGURED/);
    expect(validatePolicy(archive({ gracePeriodDays: null }), { ...ctx, defaultGracePeriodDays: 30 })).toEqual([]);
    expect(policyStatus(archive({ gracePeriodDays: null }), ctx)).toBe("incomplete");
  });
});

describe("eligibility cutoff — protected period + configurable grace", () => {
  it("subtracts months then grace days", () => {
    expect(eligibilityCutoffDay("2026-09-30", 6, 0)).toBe("2026-03-30");
    expect(eligibilityCutoffDay("2026-09-30", 6, 30)).toBe("2026-02-28");
    expect(eligibilityCutoffDay("2026-09-30", 6, 7)).toBe("2026-03-23");
  });
  it("uses the application's time zone for 'today'", () => {
    const t = new Date("2026-09-30T20:00:00Z");
    expect(localToday("UTC", t)).toBe("2026-09-30");
    expect(localToday("Asia/Kolkata", t)).toBe("2026-10-01");
  });
});
