import { describe, expect, it } from "vitest";
import { classifyRecords, nextThreshold, projectDaysToThreshold } from "./severity";

const T = { low: 1_000_000, medium: 1_100_000, high: 1_200_000 };

describe("classifyRecords", () => {
  it("maps the 10L / 11L / 12L thresholds inclusively", () => {
    expect(classifyRecords(999_999, T)).toBe("NONE");
    expect(classifyRecords(1_000_000, T)).toBe("LOW");
    expect(classifyRecords(1_099_999, T)).toBe("LOW");
    expect(classifyRecords(1_100_000, T)).toBe("MEDIUM");
    expect(classifyRecords(1_200_000, T)).toBe("HIGH");
    expect(classifyRecords(1_204_821, T)).toBe("HIGH");
  });
});

describe("nextThreshold / projection", () => {
  it("computes records remaining to the next threshold", () => {
    const next = nextThreshold(982_400, T);
    expect(next).toEqual({ level: "LOW", threshold: 1_000_000 });
    expect(projectDaysToThreshold(1_000_000 - 982_400, 1_240)).toBe(15);
  });

  it("returns null above HIGH and for non-positive growth", () => {
    expect(nextThreshold(1_300_000, T)).toBeNull();
    expect(projectDaysToThreshold(null, 100)).toBeNull();
    expect(projectDaysToThreshold(500, 0)).toBeNull();
  });
});
