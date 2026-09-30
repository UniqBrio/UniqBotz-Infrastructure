import type pg from "pg";
import type { GrowthResult } from "../health/growth";
import type { DiscoveredTable, DiscoveryResult } from "./catalog";

/**
 * READ-ONLY discovery report (Phase 3C §9–10). Produced from catalog metadata, statistics, optional exact
 * counts of small tables and growth availability. It never reads row contents and never writes to the
 * application. Suggestions (candidate archive tables, tables to protect) are HEURISTICS for human review,
 * labelled as such — every table stays REVIEW_REQUIRED until an operator configures it.
 */

export interface PrivilegeFinding {
  table: string;
  privileges: string[];
}

/** Tables on which the connected role could write. For a monitor role this must be empty. */
export async function auditWritePrivileges(c: pg.Client, tables: string[]): Promise<PrivilegeFinding[]> {
  const out: PrivilegeFinding[] = [];
  for (const t of tables) {
    const r = (await c.query(
      `SELECT has_table_privilege(current_user, $1, 'INSERT') AS i, has_table_privilege(current_user, $1, 'UPDATE') AS u,
              has_table_privilege(current_user, $1, 'DELETE') AS d, has_table_privilege(current_user, $1, 'TRUNCATE') AS t`, [t])).rows[0];
    const p = [r.i && "INSERT", r.u && "UPDATE", r.d && "DELETE", r.t && "TRUNCATE"].filter(Boolean) as string[];
    if (p.length) out.push({ table: t, privileges: p });
  }
  return out;
}

export interface DiscoveryReportInput {
  applicationId: string;
  applicationName: string;
  environment: string;
  timeZone: string | null;
  generatedAt: string;
  method: string;
  role: { name: string; bypassRls: boolean; superuser: boolean };
  sessionReadOnly: boolean;
  disc: DiscoveryResult;
  exactCounts: Record<string, number | null>;
  growth: Record<string, GrowthResult | null>;
  writePrivileges: PrivilegeFinding[];
}

const MB = 1024 * 1024;
const fmt = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n.toLocaleString("en-IN"));
const mb = (b: number) => `${(b / MB).toFixed(2)} MB`;

/** Heuristic only: a table referenced by others without its own date candidates looks like reference/master data. */
export function protectionHints(t: DiscoveredTable, disc: DiscoveryResult): string[] {
  const hints: string[] = [];
  const referencedBy = disc.foreignKeys.filter((e) => e.parent === t.qualified && e.child !== t.qualified).map((e) => e.child);
  if (referencedBy.length && t.dateCandidates.length === 0) hints.push(`referenced by ${referencedBy.length} table(s) and has no date column (reference/master data)`);
  else if (referencedBy.length) hints.push(`parent of ${referencedBy.join(", ")} — can only be archived together with its children`);
  if (t.primaryKey.length !== 1) hints.push(t.primaryKey.length === 0 ? "no primary key — cannot be archived (exact identity impossible)" : "composite primary key — not supported by the archive engine");
  if (/(^|_)(users?|profiles?|accounts?|members?|roles?|permissions?|settings?|config|plans?|products?|branches?|staff)(_|$)/i.test(t.name)) hints.push("name suggests identity/configuration data");
  return hints;
}

export function archiveCandidateHints(t: DiscoveredTable, rows: number | null): string[] {
  const hints: string[] = [];
  if (t.primaryKey.length !== 1) return hints;
  if (t.dateCandidates.length === 0) return hints;
  if (/(log|logs|events?|history|audit|attendance|check_?ins?|notifications?|messages?|sessions?|visits?|activity|tracking)/i.test(t.name)) hints.push("name suggests time-series / event data");
  if ((rows ?? 0) >= 100_000) hints.push(`large (${fmt(rows)} rows)`);
  return hints;
}

export function renderDiscoveryReport(i: DiscoveryReportInput): string {
  const d = i.disc;
  const tables = [...d.tables].sort((a, b) => a.qualified.localeCompare(b.qualified));
  const rowsOf = (t: DiscoveredTable) => i.exactCounts[t.qualified] ?? null;
  const L: string[] = [];
  L.push(`# ${i.applicationName} — Read-Only Discovery Report`, "");
  L.push("> **READ-ONLY.** Nothing was modified, archived or deleted. No row contents were read.", "");
  L.push("## Method (observed facts)", "");
  L.push(`- Application: \`${i.applicationId}\` (${i.environment})`);
  L.push(`- Generated: ${i.generatedAt}`);
  L.push(`- Method: ${i.method}`);
  L.push(`- Connected role: \`${i.role.name}\` (BYPASSRLS: ${i.role.bypassRls ? "yes" : "no"}, superuser: ${i.role.superuser ? "yes" : "no"}); session read-only: ${i.sessionReadOnly ? "yes" : "NO"}`);
  L.push(`- Server: PostgreSQL ${d.serverVersion}; database size ${mb(d.databaseBytes)}; ${tables.length} tables in ${d.schemas.length} schema(s): ${d.schemas.join(", ")}`);
  L.push(`- Business time zone: ${i.timeZone ?? "**NOT CONFIGURED** (growth cannot be measured)"}`, "");
  L.push("## Tables", "");
  L.push("| Table | PK | Rows (exact) | Rows (estimate) | Table size | Index size | Dead tuples | RLS | Date columns | Insertion column |", "|---|---|---|---|---|---|---|---|---|---|");
  for (const t of tables) {
    L.push(`| \`${t.qualified}\` | ${t.primaryKey.join(", ") || "**none**"} | ${fmt(rowsOf(t))} | ${fmt(t.estimatedRows)} | ${mb(t.tableBytes)} | ${mb(t.indexBytes)} | ${fmt(t.deadTuples)} | ${t.rls.enabled ? (t.rls.forced ? "forced" : "on") : "off"} | ${t.dateCandidates.join(", ") || "—"} | ${t.insertionColumn ?? "—"} |`);
  }
  L.push("", "## Foreign keys", "");
  if (!d.foreignKeys.length) L.push("None discovered.");
  else {
    L.push("| Constraint | Child → Parent | Columns | ON DELETE |", "|---|---|---|---|");
    for (const e of d.foreignKeys) L.push(`| ${e.name} | \`${e.child}\` → \`${e.parent}\` | ${e.childColumns.join(", ")} → ${e.parentColumns.join(", ")} | ${e.onDelete} |`);
  }
  L.push("", "## Growth history availability", "");
  for (const t of tables) {
    const g = i.growth[t.qualified];
    L.push(`- \`${t.qualified}\`: ${!g ? "not measured" : g.status === "measured" ? `measured on \`${g.column}\` — ${fmt(g.avgPerDay)} rows/day (6 complete months, surviving rows only)` : `INSUFFICIENT HISTORY — ${g.reason}`}`);
  }
  L.push("", "## RLS findings", "");
  const rls = tables.filter((t) => t.rls.enabled);
  if (!rls.length) L.push("No table has row-level security enabled.");
  for (const t of rls) L.push(`- \`${t.qualified}\`: RLS ${t.rls.forced ? "FORCED" : "enabled"}${i.role.bypassRls || i.role.superuser ? " — the connected role bypasses RLS" : " — **the connected role cannot bypass RLS: counts/growth through it are understated; archiving would be blocked (rls_hides_rows)**"}`);
  L.push("", "## Write privileges of the connected role", "");
  L.push(i.writePrivileges.length ? `**WARNING:** the role could write to ${i.writePrivileges.length} table(s) (the session was read-only, so nothing was written). A monitor role should hold SELECT only:` : "None — the role holds no INSERT/UPDATE/DELETE/TRUNCATE privilege on discovered tables.");
  for (const p of i.writePrivileges) L.push(`- \`${p.table}\`: ${p.privileges.join(", ")}`);
  L.push("", "## Candidate archive tables (HEURISTIC — for review, not a decision)", "");
  const cands = tables.map((t) => [t, archiveCandidateHints(t, rowsOf(t) ?? t.estimatedRows)] as const).filter(([, h]) => h.length);
  if (!cands.length) L.push("No table matched the time-series heuristics.");
  for (const [t, h] of cands) L.push(`- \`${t.qualified}\` — ${h.join("; ")}; date column(s): ${t.dateCandidates.join(", ")}`);
  L.push("", "## Tables that should remain protected (HEURISTIC — for review)", "");
  const prot = tables.map((t) => [t, protectionHints(t, d)] as const).filter(([, h]) => h.length);
  if (!prot.length) L.push("No table matched the protection heuristics.");
  for (const [t, h] of prot) L.push(`- \`${t.qualified}\` — ${h.join("; ")}`);
  L.push("", "## Configuration gaps", "");
  L.push("- Every table above is **REVIEW_REQUIRED** — nothing can be archived until an operator configures it.");
  if (!i.timeZone) L.push("- APPLICATION TIMEZONE NOT CONFIGURED.");
  L.push("- Grace period, protected period, target and date column per table: NOT CONFIGURED.", "- Archive provider: NOT CONFIGURED (ARCHIVE EXECUTION UNAVAILABLE).");
  const noPk = tables.filter((t) => t.primaryKey.length !== 1);
  if (noPk.length) L.push(`- ${noPk.length} table(s) without a single-column primary key: ${noPk.map((t) => `\`${t.qualified}\``).join(", ")}.`);
  return `${L.join("\n")}\n`;
}
