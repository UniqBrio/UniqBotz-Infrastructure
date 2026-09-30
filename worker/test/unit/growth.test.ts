import { describe, expect, it } from "vitest";
import { detectSpikes, growthWindow } from "../../health/growth";

describe("six-month growth window", () => {
  it("is the last six COMPLETE calendar months, excluding the current month", () => {
    const w = growthWindow("2026-09-30");
    expect(w.start).toBe("2026-03-01");
    expect(w.end).toBe("2026-09-01");
    expect(w.months.map((m) => m.month)).toEqual(["2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"]);
    expect(w.months.reduce((s, m) => s + m.days, 0)).toBe(184);
  });
  it("crosses year boundaries and leap Februaries", () => {
    const w = growthWindow("2028-03-15");
    expect(w.start).toBe("2027-09-01");
    expect(w.months.find((m) => m.month === "2028-02")!.days).toBe(29);
  });
});

describe("spike (backfill) detection", () => {
  it("flags days above 5× the median", () => {
    const daily = Array.from({ length: 30 }, (_, i) => ({ day: `2026-08-${String(i + 1).padStart(2, "0")}`, rows: 100 }));
    daily[10] = { day: "2026-08-11", rows: 5000 };
    expect(detectSpikes(daily)).toEqual([{ day: "2026-08-11", rows: 5000 }]);
  });
  it("needs at least a week of data", () => {
    expect(detectSpikes([{ day: "2026-08-01", rows: 1 }, { day: "2026-08-02", rows: 1000 }])).toEqual([]);
  });
});
