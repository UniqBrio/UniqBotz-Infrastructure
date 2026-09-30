import { describe, expect, it } from "vitest";
import { loadWorkerConfig } from "../../config";
import { evaluateDeletionGate, type DeletionGateInput } from "../../deletion/gate";
import { buildBatches } from "../../deletion/batch";

const now = new Date("2026-09-30T06:00:00Z");
const open = (): DeletionGateInput => ({
  config: { allowDeletion: true, deletionAllowedEnvironments: ["synthetic"], verificationMaxAgeMinutes: 60 },
  environment: "synthetic",
  killSwitch: false,
  jobStatus: "deletion_approved",
  jobMode: "ARCHIVE_VERIFY_DELETE",
  verification: { verified: true, attempt: 1, verifiedAt: "2026-09-30T05:30:00Z" },
  currentAttempt: 1,
  jobSchemaHash: "s",
  liveSchemaHash: "s",
  jobGraphHash: "g",
  liveGraphHash: "g",
  candidateSetIntact: true,
  now,
});

describe("deletion gate", () => {
  it("allows only when every condition holds (synthetic test configuration)", () => {
    expect(evaluateDeletionGate(open())).toEqual({ allowed: true, reasons: [] });
  });

  it("refuses with the Phase 3B default config regardless of job state", () => {
    const cfg = loadWorkerConfig({});
    const r = evaluateDeletionGate({ ...open(), config: cfg });
    expect(r.allowed).toBe(false);
    expect(r.reasons[0]).toMatch(/ALLOW_DELETION=false/);
  });

  it.each([
    [{ environment: "production" as const }, /environment 'production'/],
    [{ environment: "staging" as const }, /environment 'staging'/],
    [{ killSwitch: true }, /kill switch is ON/],
    [{ jobMode: "ARCHIVE_AND_VERIFY_ONLY" as const }, /job mode is ARCHIVE_AND_VERIFY_ONLY/],
    [{ jobStatus: "ready_for_deletion" }, /requires deletion_approved/],
    [{ verification: null }, /no archive verification/],
    [{ verification: { verified: false, attempt: 1, verifiedAt: "2026-09-30T05:30:00Z" } }, /VERIFICATION FAILED — DELETE = 0/],
    [{ verification: { verified: true, attempt: 1, verifiedAt: "2026-09-29T00:00:00Z" } }, /re-verify/],
    [{ currentAttempt: 2 }, /different export attempt/],
    [{ liveSchemaHash: "changed" }, /schema hash changed/],
    [{ jobSchemaHash: null }, /schema hash changed/],
    [{ liveGraphHash: "changed" }, /FK graph changed/],
    [{ candidateSetIntact: false }, /integrity/],
  ])("refuses: %o", (patch, reason) => {
    const r = evaluateDeletionGate({ ...open(), ...patch });
    expect(r.allowed).toBe(false);
    expect(r.reasons.join("\n")).toMatch(reason);
  });

  it("reports every reason, not only the first", () => {
    const r = evaluateDeletionGate({ ...open(), config: loadWorkerConfig({}), killSwitch: true, environment: "production", jobMode: "ARCHIVE_AND_VERIFY_ONLY" });
    expect(r.reasons.length).toBeGreaterThanOrEqual(4);
  });
});

describe("buildBatches — exact keys, children with their parents, configurable size", () => {
  it("keeps each root key's children in the same batch", () => {
    const keys = {
      "public.a": [1, 2, 3, 4, 5].map((i) => ({ pk: String(i), fp: `f${i}`, parentKey: null })),
      "public.b": [1, 1, 2, 5].map((p, i) => ({ pk: `c${i}`, fp: `x${i}`, parentKey: String(p) })),
    };
    const batches = buildBatches(keys, "public.a", ["public.b", "public.a"], { "public.a": null, "public.b": "public.a" }, 2);
    expect(batches).toHaveLength(3);
    const flat = batches.flatMap((b) => b["public.a"]!.map((k) => k.pk));
    expect(flat).toEqual(["1", "2", "3", "4", "5"]);
    for (const b of batches) {
      const roots = new Set(b["public.a"]!.map((k) => k.pk));
      for (const child of b["public.b"] ?? []) expect(roots.has(child.parentKey!)).toBe(true);
    }
  });
});
