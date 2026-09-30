import type pg from "pg";
import { audit } from "../audit/audit";
import { openConnection } from "../connection/connect";
import type { SecretResolver } from "../connection/secrets";
import { loadApplication } from "../controlplane/repository";
import { collectApplication, type CollectOptions } from "../health/collector";
import type { GrowthResult } from "../health/growth";
import { discoverDatabase } from "./catalog";
import { auditWritePrivileges, renderDiscoveryReport } from "./report";

/**
 * The FIRST production connection procedure (Phase 3C §9): READ-ONLY DISCOVERY ONLY.
 *  1. refuses unless the application has a monitor connection and NO archive capability;
 *  2. runs the normal read-only collection (discovery persisted, every new table REVIEW_REQUIRED, small-table
 *     exact counts, growth when a time zone is configured);
 *  3. re-reads the catalog (metadata only), audits the monitor role's write privileges and session read-only
 *     state, and renders the discovery report.
 * It never reads row contents, never writes to the application, and creates no job.
 */
export async function runReadOnlyDiscovery(cp: pg.Client, secrets: SecretResolver, applicationId: string, opts: CollectOptions & { method?: string } = {}) {
  const app = await loadApplication(cp, applicationId);
  if (!app.connections.monitor) throw new Error(`${applicationId}: no monitor connection registered`);
  if (app.capabilities.archive) throw new Error(`${applicationId}: read-only discovery requires archive capability OFF`);
  const collected = await collectApplication(cp, secrets, applicationId, opts);
  if (!collected.ok) throw new Error(`read-only collection failed: ${collected.error}`);
  const c = await openConnection(app.connections.monitor, secrets, { applicationName: "uniqbotz-discovery-readonly" });
  try {
    const readOnly = (await c.query(`SHOW default_transaction_read_only`)).rows[0].default_transaction_read_only === "on";
    const role = (await c.query(`SELECT current_user AS name, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user`)).rows[0];
    const disc = await discoverDatabase(c);
    const writePrivileges = await auditWritePrivileges(c, disc.tables.map((t) => t.qualified));
    const stored = (await cp.query(`SELECT schema_name || '.' || table_name AS q, exact_rows, growth FROM control.discovered_tables WHERE application_id = $1 AND is_present`, [applicationId])).rows;
    const report = renderDiscoveryReport({
      applicationId, applicationName: app.name, environment: app.environment, timeZone: app.timeZone, generatedAt: (opts.now ?? new Date()).toISOString(),
      method: opts.method ?? "worker monitor connection (session default_transaction_read_only=on); catalog + statistics; exact counts only for small tables",
      role: { name: role.name, bypassRls: role.rolbypassrls, superuser: role.rolsuper }, sessionReadOnly: readOnly, disc,
      exactCounts: Object.fromEntries(stored.map((r) => [r.q as string, r.exact_rows === null ? null : Number(r.exact_rows)])),
      growth: Object.fromEntries(stored.map((r) => [r.q as string, (r.growth ?? null) as GrowthResult | null])),
      writePrivileges,
    });
    await audit(cp, { action: "discovery_report", result: writePrivileges.length || !readOnly ? "failure" : "success", applicationId,
      detail: { tables: disc.tables.length, sessionReadOnly: readOnly, writePrivilegeTables: writePrivileges.length, newTables: collected.newTables.length } });
    return { report, collected, writePrivileges, sessionReadOnly: readOnly };
  } finally {
    await c.end().catch(() => {});
  }
}
