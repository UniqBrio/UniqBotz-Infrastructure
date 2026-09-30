import type pg from "pg";
import { isRole, type Role } from "../../src/lib/auth/permissions";
import { audit } from "../audit/audit";

/** Operator identities and role grants. Roles live here, never in identity-token claims. */
export interface OperatorRecord {
  id: string;
  email: string;
  displayName: string | null;
  active: boolean;
  roles: Role[];
}

export async function loadOperator(cp: pg.Client | pg.PoolClient, id: string): Promise<OperatorRecord | null> {
  const o = (await cp.query(`SELECT id, email, display_name, active FROM control.operators WHERE id = $1`, [id])).rows[0];
  if (!o) return null;
  const roles = (await cp.query(`SELECT role FROM control.operator_roles WHERE operator_id = $1 ORDER BY role`, [id])).rows.map((r) => r.role as string).filter(isRole);
  return { id: o.id, email: o.email, displayName: o.display_name, active: o.active, roles: o.active ? roles : [] };
}

/** Bootstrap/admin path (CLI or an ADMIN through the API). Audited. */
export async function upsertOperator(cp: pg.Client, op: { id: string; email: string; displayName?: string | null }, by: string) {
  await cp.query(
    `INSERT INTO control.operators (id, email, display_name, created_by) VALUES ($1,$2,$3,$4)
     ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name`,
    [op.id, op.email, op.displayName ?? null, by]);
  await audit(cp, { action: "operator_action", result: "success", actor: { type: "user", name: by }, detail: { operator: op.id, change: "upsert" } });
}

export async function grantRole(cp: pg.Client, operatorId: string, role: Role, by: string) {
  await cp.query(`INSERT INTO control.operator_roles (operator_id, role, granted_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [operatorId, role, by]);
  await audit(cp, { action: "operator_action", result: "success", actor: { type: "user", name: by }, detail: { operator: operatorId, grant: role } });
}

export async function revokeRole(cp: pg.Client, operatorId: string, role: Role, by: string) {
  await cp.query(`DELETE FROM control.operator_roles WHERE operator_id = $1 AND role = $2`, [operatorId, role]);
  await audit(cp, { action: "operator_action", result: "success", actor: { type: "user", name: by }, detail: { operator: operatorId, revoke: role } });
}

export async function disableOperator(cp: pg.Client, operatorId: string, by: string) {
  await cp.query(`UPDATE control.operators SET active = false, disabled_at = now() WHERE id = $1`, [operatorId]);
  await audit(cp, { action: "operator_action", result: "success", actor: { type: "user", name: by }, detail: { operator: operatorId, disabled: true } });
}
