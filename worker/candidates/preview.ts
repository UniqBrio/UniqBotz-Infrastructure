import type pg from "pg";
import type { CandidateDay } from "../../src/lib/domain/types";
import { qi } from "../connection/connect";
import { beginOwned } from "../connection/transaction";
import type { GroupPlan } from "../retention/group";
import { addDays, rootPredicate, selectCandidate } from "./selection";

/**
 * READ-ONLY candidate preview. Runs in a REPEATABLE READ READ ONLY transaction: it cannot write,
 * freezes nothing, and creates no job. A boundary is reported ONLY when the target is reached.
 */
export interface ExclusionLine {
  reason: "null_date" | "protected_period" | "after_boundary" | "target_not_reached";
  rows: number;
  detail: string;
}

export interface CandidatePreview {
  applicationId: string;
  root: string;
  tables: string[];
  dateColumn: string;
  timeZone: string;
  cutoffDay: string;
  target: number;
  status: "ready" | "target_not_reached" | "no_eligible_rows" | "blocked";
  blocking: string[];
  warnings: string[];
  oldestEligibleDate: string | null;
  boundaryDate: string | null;
  finalDayCount: number | null;
  totalBeforeFinalDay: number | null;
  candidateCount: number;
  totalsByTable: Record<string, number>;
  /** Eligible days up to the boundary plus up to 14 following days (for the timeline). */
  days: CandidateDay[];
  excluded: ExclusionLine[];
  computedAt: string;
  schemaHash: string;
}

export async function previewCandidate(c: pg.Client, plan: GroupPlan): Promise<CandidatePreview> {
  const base = {
    applicationId: plan.spec.applicationId,
    root: plan.spec.root,
    tables: plan.spec.tables,
    dateColumn: plan.spec.dateColumn,
    timeZone: plan.spec.timeZone,
    cutoffDay: plan.spec.cutoffDay,
    target: plan.spec.target,
    blocking: plan.blocking,
    warnings: plan.warnings,
    computedAt: new Date().toISOString(),
    schemaHash: plan.schemaHash,
  };
  if (plan.blocking.length) {
    return { ...base, status: "blocked", oldestEligibleDate: null, boundaryDate: null, finalDayCount: null, totalBeforeFinalDay: null,
      candidateCount: 0, totalsByTable: {}, days: [], excluded: [] };
  }
  await beginOwned(c, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const sel = await selectCandidate(c, plan);
    const root = qi(plan.spec.root);
    const col = qi(plan.spec.dateColumn);
    const nullRows = Number((await c.query(`SELECT count(*) n FROM ${root} WHERE ${col} IS NULL`)).rows[0].n);
    const eligibleRoot = Number((await c.query(`SELECT count(*) n FROM ${root} t WHERE ${rootPredicate(plan, plan.spec.cutoffDay)}`)).rows[0].n);
    const allNonNull = Number((await c.query(`SELECT count(*) n FROM ${root} WHERE ${col} IS NOT NULL`)).rows[0].n);
    const eligibleTotal = sel.eligibleDays.reduce((s, d) => s + Object.values(d.countsByTable).reduce((a, b) => a + b, 0), 0);
    await c.query("COMMIT");

    const excluded: ExclusionLine[] = [
      { reason: "null_date", rows: nullRows, detail: `${plan.spec.root}.${plan.spec.dateColumn} IS NULL — never eligible` },
      { reason: "protected_period", rows: allNonNull - eligibleRoot, detail: `root rows on/after ${plan.spec.cutoffDay} (protected period + grace)` },
    ];
    if (sel.reachedTarget) excluded.push({ reason: "after_boundary", rows: eligibleTotal - sel.totalSelected, detail: `eligible group rows after the final complete day ${sel.boundaryDate}` });
    else if (eligibleTotal > 0) excluded.push({ reason: "target_not_reached", rows: eligibleTotal, detail: `all ${eligibleTotal} eligible rows are below the ${plan.spec.target} target — no boundary is proposed` });

    const until = sel.boundaryDate ? addDays(sel.boundaryDate, 14) : null;
    const days = until ? sel.eligibleDays.filter((d) => d.date <= until) : sel.eligibleDays;
    return {
      ...base,
      status: eligibleTotal === 0 ? "no_eligible_rows" : sel.reachedTarget ? "ready" : "target_not_reached",
      oldestEligibleDate: sel.eligibleDays[0]?.date ?? null,
      boundaryDate: sel.reachedTarget ? sel.boundaryDate : null,
      finalDayCount: sel.reachedTarget ? sel.finalDayCount : null,
      totalBeforeFinalDay: sel.reachedTarget ? sel.totalBeforeFinalDay : null,
      candidateCount: sel.reachedTarget ? sel.totalSelected : 0,
      totalsByTable: sel.reachedTarget ? sel.totalsByTable : {},
      days,
      excluded,
    };
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  }
}
