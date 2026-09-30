/**
 * Control-plane authorization model (Phase 3C §4). Pure and shared by the web server, the worker and the UI.
 *
 * Roles are granted in control.operator_roles by an ADMIN — never taken from identity-token claims.
 * WHO holds each role is a business decision (checklist A-1 … A-5); nobody holds a role until granted.
 *
 * Principles
 *  - Nobody can EXECUTE deletion from the dashboard. Execution is performed only by the worker, which
 *    re-validates every gate itself (ALLOW_DELETION, environment, kill switch, verification, schema/graph hash,
 *    candidate fingerprints, approvals, authorization, deletion window).
 *  - Separation of duties: the person who authorizes a deletion may not be one of its approvers, and
 *    APPROVER is not an ADMIN permission (a user needs both roles granted explicitly to do both, and even
 *    then may not approve and authorize the same job).
 *  - Stopping is easy, resuming is restricted: any OPERATOR/APPROVER/ADMIN may ENGAGE the kill switch;
 *    only an ADMIN may RELEASE it.
 */
export const ROLES = ["VIEWER", "OPERATOR", "APPROVER", "ADMIN"] as const;
export type Role = (typeof ROLES)[number];

export const ACTIONS = [
  "view",                        // health, tables, alerts, previews, jobs, audit log
  "edit_policy_draft",           // classify tables (REVIEW_REQUIRED / DO_NOT_ARCHIVE) and draft ARCHIVE settings (never enables)
  "change_retention",            // set/enable retention values: date column, protected period, grace, target, enabled
  "start_archive_verification",  // create an ARCHIVE_AND_VERIFY_ONLY job (zero delete)
  "cancel_job",
  "approve_deletion",            // record an approve/reject decision bound to the reviewed evidence
  "authorize_deletion",          // issue the explicit, expiring authorization after the approval quorum
  "execute_deletion",            // NOBODY — worker only
  "engage_kill_switch",
  "release_kill_switch",
  "change_settings",             // thresholds, targets, approval policy values
  "change_credentials",          // connection hosts/users and SECRET REFERENCES (never secret values)
  "register_application",
  "manage_operators",            // grant/revoke roles, disable operators
] as const;
export type Action = (typeof ACTIONS)[number];

export const ROLE_PERMISSIONS: Record<Role, readonly Action[]> = {
  VIEWER: ["view"],
  OPERATOR: ["view", "edit_policy_draft", "start_archive_verification", "cancel_job", "engage_kill_switch"],
  APPROVER: ["view", "approve_deletion", "engage_kill_switch"],
  ADMIN: [
    "view", "edit_policy_draft", "change_retention", "cancel_job", "authorize_deletion", "engage_kill_switch", "release_kill_switch",
    "change_settings", "change_credentials", "register_application", "manage_operators",
  ],
};

export const ACTION_DESCRIPTIONS: Record<Action, string> = {
  view: "View health, tables, alerts, candidate previews, jobs and the audit log",
  edit_policy_draft: "Classify tables and draft Archive settings (cannot enable a policy)",
  change_retention: "Change retention values and enable/disable Archive policies",
  start_archive_verification: "Start an ARCHIVE_AND_VERIFY_ONLY job (never deletes)",
  cancel_job: "Cancel a job that has not started deleting",
  approve_deletion: "Approve or reject deletion of a verified job, bound to the evidence reviewed",
  authorize_deletion: "Issue the final, expiring deletion authorization after the approval quorum",
  execute_deletion: "Execute deletion — no human role; the worker only",
  engage_kill_switch: "Engage the deletion kill switch (stop)",
  release_kill_switch: "Release the deletion kill switch (allow)",
  change_settings: "Change thresholds, targets and approval-policy values",
  change_credentials: "Change connection settings and secret references (never secret values)",
  register_application: "Register or disable an application",
  manage_operators: "Grant/revoke roles and disable operators",
};

export function permissionsFor(roles: readonly Role[]): Action[] {
  const set = new Set<Action>();
  for (const r of roles) for (const a of ROLE_PERMISSIONS[r] ?? []) set.add(a);
  set.delete("execute_deletion");
  return ACTIONS.filter((a) => set.has(a));
}

export function can(roles: readonly Role[], action: Action): boolean {
  if (action === "execute_deletion") return false;
  return roles.some((r) => (ROLE_PERMISSIONS[r] ?? []).includes(action));
}

export function isRole(v: string): v is Role {
  return (ROLES as readonly string[]).includes(v);
}
