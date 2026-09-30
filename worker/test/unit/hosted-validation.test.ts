import { describe, expect, it } from "vitest";
import { assertDisposable, KNOWN_PRODUCTION_REFS } from "../../hosted-validation/validate";

describe("hosted validation safety rails", () => {
  const base = { HV_PROJECT_REF: "abcdefdisposable", HV_CONFIRM_DISPOSABLE: "I-CONFIRM-abcdefdisposable-IS-DISPOSABLE",
    HV_OWNER_URL: "postgres://postgres:x@db.abcdefdisposable.supabase.co:5432/postgres" };
  it("refuses the RosiFit production project outright", () => {
    const ref = KNOWN_PRODUCTION_REFS[0]!;
    expect(() => assertDisposable({ ...base, HV_PROJECT_REF: ref, HV_CONFIRM_DISPOSABLE: `I-CONFIRM-${ref}-IS-DISPOSABLE` })).toThrow(/known PRODUCTION project/);
  });
  it("requires the typed confirmation", () => {
    expect(() => assertDisposable({ ...base, HV_CONFIRM_DISPOSABLE: "yes" })).toThrow(/HV_CONFIRM_DISPOSABLE/);
  });
  it("refuses URLs that point at a different project", () => {
    expect(() => assertDisposable({ ...base, HV_OWNER_URL: "postgres://postgres:x@db.someotherproject.supabase.co:5432/postgres" })).toThrow(/does not point at project/);
    expect(assertDisposable(base)).toEqual({ ref: "abcdefdisposable", local: false });
  });
  it("a local rehearsal may only target 127.0.0.1", () => {
    const local = { ...base, HV_LOCAL_REHEARSAL: "1", HV_OWNER_URL: "postgres://postgres:x@127.0.0.1:54329/hv" };
    expect(assertDisposable(local).local).toBe(true);
    expect(() => assertDisposable({ ...local, HV_OWNER_URL: base.HV_OWNER_URL })).toThrow(/local rehearsal allows 127.0.0.1 only/);
  });
});
