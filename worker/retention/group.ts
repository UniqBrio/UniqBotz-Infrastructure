import type pg from "pg";
import { describeIssue, deletionOrder, discoverEdges, graphHash, validateSelection, type FkEdge } from "../discovery/fkGraph";
import { describeTable, schemaHash, type TableSchema } from "../schema/describe";

/**
 * A root-driven archive group (ADR §5.3): the ROOT table's date column defines the day; other
 * selected tables join through the discovered FK closure. Planning is read-only.
 */
export interface GroupSpec {
  applicationId: string;
  root: string; // schema-qualified
  dateColumn: string;
  tables: string[]; // selected tables incl. root
  timeZone: string;
  cutoffDay: string; // YYYY-MM-DD exclusive: rows on/after this local day are protected (protected period + grace)
  target: number;
}

export interface GroupPlan {
  spec: GroupSpec;
  schemas: Record<string, TableSchema>;
  edges: FkEdge[];
  links: Record<string, FkEdge>;
  deleteOrder: string[];
  exportOrder: string[];
  schemaHash: string;
  graphHash: string;
  dateColumnType: string;
  blocking: string[];
  warnings: string[];
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TZ = /^[A-Za-z_]+(\/[A-Za-z_+-]+)*$/;

export class PlanBlockedError extends Error {
  constructor(public blocking: string[]) {
    super(`group plan blocked: ${blocking.join("; ")}`);
    this.name = "PlanBlockedError";
  }
}

export async function planGroup(c: pg.Client, spec: GroupSpec): Promise<GroupPlan> {
  if (!DAY.test(spec.cutoffDay) || !TZ.test(spec.timeZone)) throw new Error("invalid cutoff day or time zone");
  if (!spec.tables.includes(spec.root)) throw new Error("root must be one of the selected tables");
  const schemas: Record<string, TableSchema> = {};
  for (const t of spec.tables) schemas[t] = await describeTable(c, t);
  const edges = await discoverEdges(c);
  const { blocking, warnings } = validateSelection(spec.tables, edges);
  const blockingMsgs = blocking.map(describeIssue);
  const warningMsgs = warnings.map(describeIssue);

  // RLS preflight (Phase 3A P9): RLS silently hides rows and blinds reconciliation. Allowed only if the
  // connected role bypasses RLS and the table does not FORCE it for owners-only semantics we cannot see.
  const role = (await c.query(`SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user`)).rows[0];
  const bypass = Boolean(role?.rolbypassrls || role?.rolsuper);
  for (const [t, s] of Object.entries(schemas)) {
    if (s.primaryKey.length !== 1) blockingMsgs.push(`no_single_column_primary_key: ${t}`);
    if (s.rls.enabled && !bypass) blockingMsgs.push(`rls_hides_rows: ${t} has row-level security and the connected role cannot bypass it`);
  }
  const dateCol = schemas[spec.root]!.columns.find((x) => x.name === spec.dateColumn);
  if (!dateCol) blockingMsgs.push(`date_column_missing: ${spec.dateColumn}`);
  else if (!["date", "timestamp with time zone", "timestamp without time zone"].includes(dateCol.type))
    blockingMsgs.push(`date_column_not_temporal: ${spec.dateColumn} is ${dateCol.type}`);

  const links: Record<string, FkEdge> = {};
  const resolved = new Set([spec.root]);
  for (let progress = true; progress; ) {
    progress = false;
    for (const t of spec.tables) {
      if (resolved.has(t)) continue;
      const e = edges.find((x) => x.child === t && resolved.has(x.parent) && x.childColumns.length === 1);
      if (e) { links[t] = e; resolved.add(t); progress = true; }
    }
  }
  for (const t of spec.tables) if (!resolved.has(t)) blockingMsgs.push(`not_reachable_from_root: ${t}`);

  let order: string[] = [];
  try { order = deletionOrder(spec.tables, edges); } catch (e) { blockingMsgs.push(String((e as Error).message)); }
  return {
    spec,
    schemas,
    edges,
    links,
    deleteOrder: order,
    exportOrder: [...order].reverse(),
    schemaHash: schemaHash(Object.values(schemas)),
    graphHash: graphHash(edges),
    dateColumnType: dateCol?.type ?? "unknown",
    blocking: blockingMsgs,
    warnings: warningMsgs,
  };
}

export function assertPlannable(plan: GroupPlan): void {
  if (plan.blocking.length) throw new PlanBlockedError(plan.blocking);
}

/** Local-day cutoff for eligibility: today (app zone) − protected months − grace days. */
export function eligibilityCutoffDay(todayLocal: string, protectedMonths: number, graceDays: number): string {
  const d = new Date(`${todayLocal}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - protectedMonths);
  d.setUTCDate(d.getUTCDate() - graceDays);
  return d.toISOString().slice(0, 10);
}

export function localToday(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
