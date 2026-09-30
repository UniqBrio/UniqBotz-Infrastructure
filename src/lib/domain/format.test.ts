import { describe, expect, it } from "vitest";
import { formatDate } from "./format";

describe("formatDate", () => {
  it("formats ISO days and timestamps", () => {
    expect(formatDate("2026-03-23")).toMatch(/23 Mar 2026/);
  });
  it("renders missing or invalid values as an em dash instead of throwing", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate("—")).toBe("—");
    expect(formatDate("not a date")).toBe("—");
  });
});
