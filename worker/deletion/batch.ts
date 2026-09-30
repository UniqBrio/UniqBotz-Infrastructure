import type pg from "pg";
import { qi } from "../connection/connect";
import { beginOwned } from "../connection/transaction";
import type { FkEdge } from "../discovery/fkGraph";
import type { TableSchema } from "../schema/describe";
import { fingerprintSql } from "../schema/fingerprint";

/**
 * One deletion batch in ONE short transaction (ADR §11, Phase 3A P6/P7):
 *   exact PK from the frozen candidate set AND unchanged row fingerprint AND not referenced by any row.
 * Children are deleted before parents in the order DERIVED from the FK graph.
 * NEVER a date predicate.
 */
export interface KeyRow {
  pk: string;
  fp: string;
  parentKey: string | null;
}

export interface TableOutcome {
  requested: number;
  deleted: number;
  drifted: number; // present but changed since freeze → skipped
  held: number; // present, unchanged, but still referenced (e.g. a new child) → skipped
  missing: number; // already gone
}

export interface BatchContext {
  deleteOrder: string[];
  schemas: Record<string, TableSchema>;
  edges: FkEdge[];
  lockTimeoutMs: number;
  statementTimeoutMs: number;
  /** Test hook: runs inside the transaction after the deletes, before COMMIT. */
  beforeCommit?: () => Promise<void>;
}

export async function deleteBatch(c: pg.Client, ctx: BatchContext, byTable: Record<string, KeyRow[]>): Promise<Record<string, TableOutcome>> {
  const out: Record<string, TableOutcome> = {};
  await beginOwned(c); // refuses to nest inside a caller's transaction
  try {
    await c.query(`SET LOCAL lock_timeout = ${Math.floor(ctx.lockTimeoutMs)}`);
    await c.query(`SET LOCAL statement_timeout = ${Math.floor(ctx.statementTimeoutMs)}`);
    for (const table of ctx.deleteOrder) {
      const rows = byTable[table] ?? [];
      if (rows.length === 0) { out[table] = { requested: 0, deleted: 0, drifted: 0, held: 0, missing: 0 }; continue; }
      const s = ctx.schemas[table]!;
      const pk = s.primaryKey[0]!;
      const pkType = s.columns.find((x) => x.name === pk)!.type;
      const refGuards = ctx.edges
        .filter((e) => e.parent === table)
        .map((e) => `AND NOT EXISTS (SELECT 1 FROM ${qi(e.child)} r WHERE r.${qi(e.childColumns[0]!)} = t.${qi(e.parentColumns[0]!)})`)
        .join(" ");
      const del = await c.query(
        `WITH m(pk, fp) AS (SELECT * FROM unnest($1::text[], $2::text[]))
         DELETE FROM ${qi(table)} t USING m
         WHERE t.${qi(pk)} = m.pk::${pkType} AND ${fingerprintSql("t")} = m.fp ${refGuards}
         RETURNING t.${qi(pk)}::text AS pk`,
        [rows.map((r) => r.pk), rows.map((r) => r.fp)],
      );
      const deleted = new Set(del.rows.map((r) => r.pk as string));
      const rest = rows.filter((r) => !deleted.has(r.pk));
      let drifted = 0, held = 0;
      if (rest.length) {
        const present = await c.query(
          `SELECT t.${qi(pk)}::text AS pk, ${fingerprintSql("t")} AS fp FROM ${qi(table)} t WHERE t.${qi(pk)} = ANY($1::${pkType}[])`,
          [rest.map((r) => r.pk)]);
        const want = new Map(rest.map((r) => [r.pk, r.fp]));
        for (const p of present.rows) {
          if (want.get(p.pk) === p.fp) held++;
          else drifted++;
        }
      }
      out[table] = { requested: rows.length, deleted: deleted.size, drifted, held, missing: rest.length - drifted - held };
    }
    if (ctx.beforeCommit) await ctx.beforeCommit();
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  }
}

/** Build batches from the root key order; children are the frozen rows whose parent key is in the batch. */
export function buildBatches(keys: Record<string, KeyRow[]>, root: string, deleteOrder: string[], parentOf: Record<string, string | null>, batchSize: number): Record<string, KeyRow[]>[] {
  const index: Record<string, Map<string, KeyRow[]>> = {};
  for (const [t, rows] of Object.entries(keys)) {
    if (t === root) continue;
    const m = new Map<string, KeyRow[]>();
    for (const r of rows) { const arr = m.get(r.parentKey!) ?? []; arr.push(r); m.set(r.parentKey!, arr); }
    index[t] = m;
  }
  const parentsFirst = [...deleteOrder].reverse();
  const out: Record<string, KeyRow[]>[] = [];
  const rootRows = keys[root]!;
  for (let i = 0; i < rootRows.length; i += batchSize) {
    const byTable: Record<string, KeyRow[]> = { [root]: rootRows.slice(i, i + batchSize) };
    for (const t of parentsFirst) {
      if (t === root) continue;
      const parent = parentOf[t];
      byTable[t] = parent && byTable[parent] ? byTable[parent]!.flatMap((p) => index[t]?.get(p.pk) ?? []) : [];
    }
    out.push(byTable);
  }
  return out;
}
