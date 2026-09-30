import { describe, expect, it } from "vitest";
import { DEFAULT_BATCH_SIZE, loadWorkerConfig, parseAllowDeletion } from "../../config";

describe("worker config — deletion disabled by default", () => {
  it("ALLOW_DELETION is false unless exactly 'true'", () => {
    expect(loadWorkerConfig({}).allowDeletion).toBe(false);
    for (const v of [undefined, "", "1", "TRUE", "yes", "True", " true", "true "]) expect(parseAllowDeletion(v)).toBe(false);
    expect(parseAllowDeletion("true")).toBe(true);
  });

  it("only the synthetic environment is allow-listed by default and production is rejected outright", () => {
    expect(loadWorkerConfig({}).deletionAllowedEnvironments).toEqual(["synthetic"]);
    expect(() => loadWorkerConfig({ DELETION_ALLOWED_ENVIRONMENTS: "synthetic,production" })).toThrow(/production/);
  });

  it("batch size defaults to 2,000, is configurable and bounded", () => {
    expect(DEFAULT_BATCH_SIZE).toBe(2000);
    expect(loadWorkerConfig({}).deletionBatchSize).toBe(2000);
    expect(loadWorkerConfig({ DELETION_BATCH_SIZE: "500" }).deletionBatchSize).toBe(500);
    expect(() => loadWorkerConfig({ DELETION_BATCH_SIZE: "0" })).toThrow();
    expect(() => loadWorkerConfig({ DELETION_BATCH_SIZE: "10000" })).toThrow();
    expect(() => loadWorkerConfig({ DELETION_BATCH_SIZE: "abc" })).toThrow();
  });
});
