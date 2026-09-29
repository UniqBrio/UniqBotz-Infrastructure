import { describe, expect, it } from "vitest";
import { dayTotal, selectWholeDays } from "./selection";
import type { CandidateDay } from "./types";

const day = (date: string, counts: Record<string, number>): CandidateDay => ({ date, countsByTable: counts });

describe("selectWholeDays", () => {
  it("includes the whole final day when it crosses the target (125,000 → 125,249)", () => {
    const days = [
      day("2025-07-30", { orders: 124_999 }),
      day("2025-07-31", { orders: 60, order_items: 70, payments: 80, audit_logs: 40 }),
      day("2025-08-01", { orders: 500 }),
    ];
    const r = selectWholeDays(days, 125_000);
    expect(r.reachedTarget).toBe(true);
    expect(r.boundaryDate).toBe("2025-07-31");
    expect(r.totalBeforeFinalDay).toBe(124_999);
    expect(r.finalDayCount).toBe(250);
    expect(r.totalSelected).toBe(125_249);
    expect(r.excludedDayCount).toBe(1);
  });

  it("matches the architecture-document example (124,999 + 210 = 125,209)", () => {
    const r = selectWholeDays([day("a", { t: 124_999 }), day("b", { t: 60 + 70 + 80 })], 125_000);
    expect(r.totalSelected).toBe(125_209);
  });

  it("processes dates in ascending order regardless of input order", () => {
    const r = selectWholeDays([day("2024-01-03", { t: 5 }), day("2024-01-01", { t: 5 }), day("2024-01-02", { t: 5 })], 10);
    expect(r.selectedDays.map((d) => d.date)).toEqual(["2024-01-01", "2024-01-02"]);
  });

  it("stops exactly on the target without taking the next day", () => {
    const r = selectWholeDays([day("1", { t: 50 }), day("2", { t: 50 }), day("3", { t: 50 })], 100);
    expect(r.totalSelected).toBe(100);
    expect(r.boundaryDate).toBe("2");
  });

  it("reports when the target is not reached", () => {
    const r = selectWholeDays([day("1", { t: 10 }), day("2", { t: 20 })], 100);
    expect(r.reachedTarget).toBe(false);
    expect(r.totalSelected).toBe(30);
  });

  it("aggregates totals per table", () => {
    const r = selectWholeDays([day("1", { a: 1, b: 2 }), day("2", { a: 3, b: 4 })], 1_000);
    expect(r.totalsByTable).toEqual({ a: 4, b: 6 });
    expect(dayTotal(day("x", { a: 1, b: 2 }))).toBe(3);
  });
});
