import type pg from "pg";
import { can } from "../../src/lib/auth/permissions";
import { audit } from "../audit/audit";
import { loadOperator } from "./operators";

export class KillSwitchRefusedError extends Error {
  constructor(why: string) {
    super(`kill switch change refused: ${why}`);
    this.name = "KillSwitchRefusedError";
  }
}

/**
 * Engage (stop) or release (allow) the global deletion kill switch.
 * Engaging: OPERATOR, APPROVER or ADMIN. Releasing: ADMIN only. Releasing it does NOT enable deletion:
 * ALLOW_DELETION, the environment allow-list, approvals and authorization are all still required.
 * The update is a single atomic statement; concurrent changes are serialised by the row lock and each is audited.
 */
export async function setKillSwitch(cp: pg.Client, input: { engaged: boolean; operatorId: string; reason: string }): Promise<{ engaged: boolean; changed: boolean }> {
  const op = await loadOperator(cp, input.operatorId);
  const action = input.engaged ? "engage_kill_switch" : "release_kill_switch";
  if (!op || !op.active || !can(op.roles, action)) {
    await audit(cp, { action: "access_denied", result: "blocked", actor: { type: "user", name: input.operatorId }, detail: { attempted: action } });
    throw new KillSwitchRefusedError(`${input.operatorId} may not ${input.engaged ? "engage" : "release"} the kill switch`);
  }
  if (!input.reason?.trim()) throw new KillSwitchRefusedError("a reason is required");
  const r = await cp.query(
    `UPDATE control.system_settings SET deletion_kill_switch = $1, kill_switch_changed_by = $2, kill_switch_changed_at = now(), updated_at = now()
     WHERE id = 1 AND deletion_kill_switch IS DISTINCT FROM $1 RETURNING deletion_kill_switch`, [input.engaged, input.operatorId]);
  const changed = r.rowCount === 1;
  await audit(cp, { action: "kill_switch_changed", result: changed ? "success" : "info", actor: { type: "user", name: input.operatorId },
    detail: { engaged: input.engaged, changed, reason: input.reason } });
  return { engaged: input.engaged, changed };
}
