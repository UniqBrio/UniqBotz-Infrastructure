/** Test-only crash injection (Phase 3A P7). Never configured in a deployed worker. */
export type CrashPoint =
  | "before_freeze"
  | "during_export"
  | "after_export_before_checkpoint"
  | "after_manifest_checkpoint"
  | "during_verification"
  | "before_deletion"
  | "mid_deletion_in_txn"
  | "mid_deletion_after_commit"
  | "after_deletion"
  | "during_deletion_verification";

export class CrashSignal extends Error {
  constructor(public point: CrashPoint) {
    super(`simulated worker crash at ${point}`);
    this.name = "CrashSignal";
  }
}
