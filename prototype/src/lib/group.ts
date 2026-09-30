/**
 * PROTOTYPE / SYNTHETIC DATA ONLY.
 * A root-driven archive group: the root table's date column defines the day;
 * other selected tables are included through the discovered FK closure (ADR §5.3).
 */
import type pg from "pg";
import { selectWholeDays } from "../../../src/lib/domain/selection.ts";
import type { CandidateDay, WholeDaySelection } from "../../../src/lib/domain/types.ts";
import { qi } from "./db.ts";
import { deletionOrder, discoverEdges, graphHash, validateSelection, type FkEdge } from "./fkGraph.ts";
import { describeTable, schemaHash, type TableSchema } from "./schema.ts";

export interface GroupSpec {
  applicationId: string;
  database: string;
  root: string; // e.g. public.orders
  dateColumn: string;
  tables: string[]; // selected tables incl. root
  timeZone: string; // business time zone, e.g. Asia/Kolkata
  cutoffDay: string; // YYYY-MM-DD, exclusive: rows on/after this local day are protected
  target: number;
}

export interface GroupPlan {
  spec: GroupSpec;
  schemas: Record<string, TableSchema>;
  edges: FkEdge[];
  /** For each non-root table: the FK edge linking it to an already-resolved selected table. */
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
const TZ = /^[A-Za-z_]+(\/[A-Za-z_]+)*$/;

export async function planGroup(c: pg.Client, spec: GroupSpec): Promise<GroupPlan> {
  if (!DAY.test(spec.cutoffDay) || !TZ.test(spec.timeZone)) throw new Error("invalid cutoff/timezone");
  const schemas: Record<string, TableSchema> = {};
  for (const t of spec.tables) schemas[t] = await describeTable(c, t);
  const edges = await discoverEdges(c);
  const { blocking, warnings } = validateSelection(spec.tables, edges);
  const blockingMsgs = blocking.map((b) => ("edge" in b ? `${b.kind}: ${b.edge.name} (${b.edge.child} → ${b.edge.parent}, ON DELETE ${b.edge.onDelete})` : `${b.kind}: ${b.tables.join(", ")}`));
  const warningMsgs = warnings.map((w) => ("edge" in w ? `${w.kind}: ${w.edge.child} → ${w.edge.parent}` : w.kind));

  for (const [t, s] of Object.entries(schemas)) {
    if (s.primaryKey.length !== 1) blockingMsgs.push(`no_single_column_primary_key: ${t}`);
    if (s.rls.enabled) blockingMsgs.push(`rls_enabled: ${t} (archiver visibility cannot be assumed complete)`);
  }
  const dateCol = schemas[spec.root]!.columns.find((x) => x.name === spec.dateColumn);
  if (!dateCol) blockingMsgs.push(`date_column_missing: ${spec.dateColumn}`);
  else if (!["date", "timestamp with time zone", "timestamp without time zone"].includes(dateCol.type))
    blockingMsgs.push(`date_column_not_temporal: ${spec.dateColumn} is ${dateCol.type}`);

  // FK closure from the root
  const links: Record<string, FkEdge> = {};
  const resolved = new Set([spec.root]);
  let progress = true;
  while (progress) {
    progress = false;
    for (const t of spec.tables) {
      if (resolved.has(t)) continue;
      const e = edges.find((x) => x.child === t && resolved.has(x.parent) && x.childColumns.length === 1);
      if (e) { links[t] = e; resolved.add(t); progress = true; }
    }
  }
  for (const t of spec.tables) if (!resolved.has(t)) blockingMsgs.push(`not_reachable_from_root: ${t} (no FK path to ${spec.root}; archive it as its own group)`);

  let order: string[] = [];
  try { order = deletionOrder(spec.tables, edges); } catch (e) { blockingMsgs.push(String(e)); }
  return {
    spec, schemas, edges, links,
    deleteOrder: order,
    exportOrder: [...order].reverse(),
    schemaHash: schemaHash(Object.values(schemas)),
    graphHash: graphHash(edges),
    dateColumnType: dateCol?.type ?? "unknown",
    blocking: blockingMsgs,
    warnings: warningMsgs,
  };
}

/** SQL literal for the start of a local day, as timestamptz. */
export function dayStart(day: string, tz: string) {
  return `(timestamp '${day} 00:00' AT TIME ZONE '${tz}')`;
}

function addDay(day: string, n = 1) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Root predicate for rows whose local day is < endDayExclusive. Sargable on the raw column. */
export function rootPredicate(plan: GroupPlan, endDayExclusive: string, alias = "t") {
  const col = `${alias}.${qi(plan.spec.dateColumn)}`;
  if (plan.dateColumnType === "date") return `${col} IS NOT NULL AND ${col} < date '${endDayExclusive}'`;
  if (plan.dateColumnType === "timestamp without time zone")
    return `${col} IS NOT NULL AND ${col} < timestamp '${endDayExclusive} 00:00'`; // zone assumed = business zone (ADR §3.5)
  return `${col} IS NOT NULL AND ${col} < ${dayStart(endDayExclusive, plan.spec.timeZone)}`;
}

export function localDayExpr(plan: GroupPlan, alias = "t") {
  const col = `${alias}.${qi(plan.spec.dateColumn)}`;
  if (plan.dateColumnType === "date") return col;
  if (plan.dateColumnType === "timestamp without time zone") return `${col}::date`;
  return `(${col} AT TIME ZONE '${plan.spec.timeZone}')::date`;
}

/** Predicate selecting table `t` rows that belong to the frozen group (FK closure for children). */
export function tablePredicate(plan: GroupPlan, table: string, endDayExclusive: string, alias = "t"): string {
  if (table === plan.spec.root) return rootPredicate(plan, endDayExclusive, alias);
  const e = plan.links[table]!;
  const parentAlias = `p_${Object.keys(plan.links).indexOf(table)}`;
  const parentPk = plan.schemas[e.parent]!.primaryKey[0]!;
  return `${alias}.${qi(e.childColumns[0]!)} IN (SELECT ${parentAlias}.${qi(parentPk)} FROM ${qi(e.parent)} ${parentAlias} WHERE ${tablePredicate(plan, e.parent, endDayExclusive, parentAlias)})`;
}

/** Daily totals across the whole group, attributed to the ROOT row's local day. */
export async function dailyTotals(c: pg.Client, plan: GroupPlan): Promise<{ days: CandidateDay[]; nullDateRows: number }> {
  const byDay = new Map<string, Record<string, number>>();
  for (const table of plan.exportOrder) {
    let sql: string;
    if (table === plan.spec.root) {
      sql = `SELECT ${localDayExpr(plan)}::text AS day, count(*)::bigint AS n FROM ${qi(table)} t
             WHERE ${rootPredicate(plan, plan.spec.cutoffDay)} GROUP BY 1`;
    } else {
      // walk the FK chain up to the root
      const chain: string[] = [];
      let cur = table;
      while (cur !== plan.spec.root) { chain.push(cur); cur = plan.links[cur]!.parent; }
      let from = `${qi(table)} a0`;
      let prevAlias = "a0";
      chain.forEach((t, i) => {
        const e = plan.links[t]!;
        const pa = `a${i + 1}`;
        from += ` JOIN ${qi(e.parent)} ${pa} ON ${prevAlias}.${qi(e.childColumns[0]!)} = ${pa}.${qi(plan.schemas[e.parent]!.primaryKey[0]!)}`;
        prevAlias = pa;
      });
      sql = `SELECT ${localDayExpr(plan, prevAlias)}::text AS day, count(*)::bigint AS n FROM ${from}
             WHERE ${rootPredicate(plan, plan.spec.cutoffDay, prevAlias)} GROUP BY 1`;
    }
    for (const r of (await c.query(sql)).rows) {
      const rec = byDay.get(r.day) ?? {};
      rec[table] = Number(r.n);
      byDay.set(r.day, rec);
    }
  }
  const nullDateRows = Number((await c.query(
    `SELECT count(*) n FROM ${qi(plan.spec.root)} WHERE ${qi(plan.spec.dateColumn)} IS NULL`)).rows[0].n);
  const days = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, countsByTable]) => ({ date, countsByTable }));
  return { days, nullDateRows };
}

export interface SelectionResult extends WholeDaySelection {
  endDayExclusive: string | null; // boundary + 1 day
  nullDateRows: number;
  eligibleDays: number;
}

export async function selectCandidate(c: pg.Client, plan: GroupPlan): Promise<SelectionResult> {
  const { days, nullDateRows } = await dailyTotals(c, plan);
  const sel = selectWholeDays(days, plan.spec.target);
  return {
    ...sel,
    selectedDays: sel.selectedDays,
    endDayExclusive: sel.boundaryDate ? addDay(sel.boundaryDate) : null,
    nullDateRows,
    eligibleDays: days.length,
  };
}
