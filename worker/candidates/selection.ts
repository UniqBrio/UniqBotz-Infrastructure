import type pg from "pg";
import { selectWholeDays } from "../../src/lib/domain/selection";
import type { CandidateDay, WholeDaySelection } from "../../src/lib/domain/types";
import { qi, ql } from "../connection/connect";
import type { GroupPlan } from "../retention/group";

/**
 * Whole-day selection (DOC §5, Phase 1 selectWholeDays unchanged). Days are local days in the
 * business time zone; child rows count on their ROOT row's day (ADR §5.3).
 */
export function dayStart(day: string, tz: string) {
  return `(timestamp ${ql(`${day} 00:00`)} AT TIME ZONE ${ql(tz)})`;
}

export function addDays(day: string, n = 1) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Root rows whose local day is < endDayExclusive. Sargable on the raw column. NULL dates never match. */
export function rootPredicate(plan: GroupPlan, endDayExclusive: string, alias = "t") {
  const col = `${alias}.${qi(plan.spec.dateColumn)}`;
  if (plan.dateColumnType === "date") return `${col} IS NOT NULL AND ${col} < date ${ql(endDayExclusive)}`;
  if (plan.dateColumnType === "timestamp without time zone") return `${col} IS NOT NULL AND ${col} < timestamp ${ql(`${endDayExclusive} 00:00`)}`;
  return `${col} IS NOT NULL AND ${col} < ${dayStart(endDayExclusive, plan.spec.timeZone)}`;
}

export function localDayExpr(plan: GroupPlan, alias = "t") {
  const col = `${alias}.${qi(plan.spec.dateColumn)}`;
  if (plan.dateColumnType === "date") return col;
  if (plan.dateColumnType === "timestamp without time zone") return `${col}::date`;
  return `(${col} AT TIME ZONE ${ql(plan.spec.timeZone)})::date`;
}

/** Rows of `table` that belong to the group for days < endDayExclusive (FK closure for children). */
export function tablePredicate(plan: GroupPlan, table: string, endDayExclusive: string, alias = "t"): string {
  if (table === plan.spec.root) return rootPredicate(plan, endDayExclusive, alias);
  const e = plan.links[table]!;
  const parentAlias = `p_${Object.keys(plan.links).indexOf(table)}`;
  const parentPk = plan.schemas[e.parent]!.primaryKey[0]!;
  return `${alias}.${qi(e.childColumns[0]!)} IN (SELECT ${parentAlias}.${qi(parentPk)} FROM ${qi(e.parent)} ${parentAlias} WHERE ${tablePredicate(plan, e.parent, endDayExclusive, parentAlias)})`;
}

export async function dailyTotals(c: pg.Client, plan: GroupPlan, endDayExclusive = plan.spec.cutoffDay): Promise<CandidateDay[]> {
  const byDay = new Map<string, Record<string, number>>();
  for (const table of plan.exportOrder) {
    let sql: string;
    if (table === plan.spec.root) {
      sql = `SELECT ${localDayExpr(plan)}::text AS day, count(*)::bigint AS n FROM ${qi(table)} t
             WHERE ${rootPredicate(plan, endDayExclusive)} GROUP BY 1`;
    } else {
      const chain: string[] = [];
      for (let cur = table; cur !== plan.spec.root; cur = plan.links[cur]!.parent) chain.push(cur);
      let from = `${qi(table)} a0`;
      let prev = "a0";
      chain.forEach((t, i) => {
        const e = plan.links[t]!;
        const pa = `a${i + 1}`;
        from += ` JOIN ${qi(e.parent)} ${pa} ON ${prev}.${qi(e.childColumns[0]!)} = ${pa}.${qi(plan.schemas[e.parent]!.primaryKey[0]!)}`;
        prev = pa;
      });
      sql = `SELECT ${localDayExpr(plan, prev)}::text AS day, count(*)::bigint AS n FROM ${from}
             WHERE ${rootPredicate(plan, endDayExclusive, prev)} GROUP BY 1`;
    }
    for (const r of (await c.query(sql)).rows) byDay.set(r.day, { ...(byDay.get(r.day) ?? {}), [table]: Number(r.n) });
  }
  return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, countsByTable]) => ({ date, countsByTable }));
}

export interface SelectionResult extends WholeDaySelection {
  /** Boundary + 1 day; null when the target was NOT reached (no boundary is proposed). */
  endDayExclusive: string | null;
  eligibleDays: CandidateDay[];
}

export async function selectCandidate(c: pg.Client, plan: GroupPlan): Promise<SelectionResult> {
  const days = await dailyTotals(c, plan);
  const sel = selectWholeDays(days, plan.spec.target);
  return {
    ...sel,
    boundaryDate: sel.reachedTarget ? sel.boundaryDate : null,
    endDayExclusive: sel.reachedTarget && sel.boundaryDate ? addDays(sel.boundaryDate) : null,
    eligibleDays: days,
  };
}
