/**
 * PROTOTYPE / SYNTHETIC DATA ONLY.
 * Exact-candidate deletion (ADR D-01, §11): PK from the verified keys file AND unchanged row fingerprint.
 * Never a date predicate. One short transaction per root batch; children deleted before parents
 * in the order DERIVED from the FK graph.
 */
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { parse } from "csv-parse";
import type pg from "pg";
import type { Manifest } from "./archive.ts";
import { qi } from "./db.ts";
import type { FkEdge } from "./fkGraph.ts";
import { FINGERPRINT, type TableSchema } from "./schema.ts";

export class NestedTransactionError extends Error {
  constructor() { super("deleteBatch refused: caller already has an open transaction (would commit caller's work)"); }
}

export interface KeyRow {
  pk: string;
  fp: string;
  parentFk: string | null;
}

export async function loadKeys(dir: string, manifest: Manifest, table: string): Promise<KeyRow[]> {
  const rows: KeyRow[] = [];
  let header = true;
  const parser = parse();
  parser.on("data", (r: string[]) => {
    if (header) { header = false; return; }
    rows.push({ pk: r[0]!, fp: r[1]!, parentFk: r[2] ?? null });
  });
  await pipeline(createReadStream(join(dir, manifest.tables[table]!.keys.path)), createGunzip(), parser);
  return rows;
}

export interface BatchOutcome {
  requested: number;
  deleted: number;
  drifted: number; // present, fingerprint differs → skipped
  held: number; // present, unchanged, but still referenced by a row outside the manifest → skipped
  missing: number; // already gone
  deletedPks: string[];
}

export interface GroupDeleteContext {
  manifest: Manifest;
  schemas: Record<string, TableSchema>;
  edges: FkEdge[];
  keys: Record<string, KeyRow[]>;
  childIndex: Record<string, Map<string, KeyRow[]>>; // table → parentPk → rows
}

export async function buildContext(dir: string, manifest: Manifest, schemas: Record<string, TableSchema>, edges: FkEdge[]): Promise<GroupDeleteContext> {
  const keys: Record<string, KeyRow[]> = {};
  const childIndex: Record<string, Map<string, KeyRow[]>> = {};
  for (const t of Object.keys(manifest.tables)) {
    keys[t] = await loadKeys(dir, manifest, t);
    if (manifest.tables[t]!.parentFk) {
      const m = new Map<string, KeyRow[]>();
      for (const k of keys[t]!) {
        const arr = m.get(k.parentFk!) ?? [];
        arr.push(k);
        m.set(k.parentFk!, arr);
      }
      childIndex[t] = m;
    }
  }
  return { manifest, schemas, edges, keys, childIndex };
}

/** Split the root key list into batches (sorted by PK as exported). */
export function rootBatches(ctx: GroupDeleteContext, batchSize: number): KeyRow[][] {
  const root = ctx.keys[ctx.manifest.root]!;
  const out: KeyRow[][] = [];
  for (let i = 0; i < root.length; i += batchSize) out.push(root.slice(i, i + batchSize));
  return out;
}

/** Rows of every group table belonging to a root batch (FK closure over the manifest). */
export function expandBatch(ctx: GroupDeleteContext, rootRows: KeyRow[]): Record<string, KeyRow[]> {
  const byTable: Record<string, KeyRow[]> = { [ctx.manifest.root]: rootRows };
  // exportOrder = parents first
  const order = [...ctx.manifest.deleteOrder].reverse();
  for (const t of order) {
    if (t === ctx.manifest.root) continue;
    const fkParent = ctx.edges.find((e) => e.child === t && e.childColumns[0] === ctx.manifest.tables[t]!.parentFk && byTable[e.parent]);
    if (!fkParent) { byTable[t] = []; continue; }
    const idx = ctx.childIndex[t]!;
    byTable[t] = byTable[fkParent.parent]!.flatMap((p) => idx.get(p.pk) ?? []);
  }
  return byTable;
}

export interface DeleteOptions {
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
  /** Test hook: runs inside the transaction after deletes, before COMMIT. */
  beforeCommit?: () => Promise<void>;
}

/** Delete one root batch (and its children) in ONE short transaction. */
export async function deleteBatch(
  c: pg.Client,
  ctx: GroupDeleteContext,
  byTable: Record<string, KeyRow[]>,
  opts: DeleteOptions = {},
): Promise<Record<string, BatchOutcome>> {
  const out: Record<string, BatchOutcome> = {};
  // Safety (found in P5): a nested BEGIN is only a warning in Postgres, and our COMMIT would then commit the
  // CALLER's transaction. The deleter must own its transaction, so refuse to run inside another one.
  let nested = false;
  const onNotice = (n: { message?: string }) => { if (/already a transaction in progress/.test(n.message ?? "")) nested = true; };
  c.on("notice", onNotice);
  await c.query("BEGIN");
  c.off("notice", onNotice);
  if (nested) throw new NestedTransactionError();
  try {
    await c.query(`SET LOCAL lock_timeout = '${opts.lockTimeoutMs ?? 2000}ms'`);
    await c.query(`SET LOCAL statement_timeout = '${opts.statementTimeoutMs ?? 30000}ms'`);
    for (const table of ctx.manifest.deleteOrder) {
      const rows = byTable[table] ?? [];
      if (rows.length === 0) { out[table] = { requested: 0, deleted: 0, drifted: 0, held: 0, missing: 0, deletedPks: [] }; continue; }
      const s = ctx.schemas[table]!;
      const pk = s.primaryKey[0]!;
      const pkType = s.columns.find((x) => x.name === pk)!.type;
      // Do not delete a row that is still referenced by ANY row (inside or outside the manifest) — orphan prevention.
      const refGuards = ctx.edges
        .filter((e) => e.parent === table)
        .map((e) => `NOT EXISTS (SELECT 1 FROM ${qi(e.child)} r WHERE r.${qi(e.childColumns[0]!)} = t.${qi(e.parentColumns[0]!)})`);
      const del = await c.query(
        `WITH m(pk, fp) AS (SELECT * FROM unnest($1::text[], $2::text[]))
         DELETE FROM ${qi(table)} t USING m
         WHERE t.${qi(pk)} = m.pk::${pkType}
           AND ${FINGERPRINT("t")} = m.fp
           ${refGuards.map((g) => `AND ${g}`).join(" ")}
         RETURNING t.${qi(pk)}::text AS pk`,
        [rows.map((r) => r.pk), rows.map((r) => r.fp)],
      );
      const deleted = new Set(del.rows.map((r) => r.pk as string));
      const rest = rows.filter((r) => !deleted.has(r.pk));
      let drifted = 0, held = 0;
      if (rest.length) {
        const present = await c.query(
          `SELECT t.${qi(pk)}::text AS pk, ${FINGERPRINT("t")} AS fp FROM ${qi(table)} t WHERE t.${qi(pk)} = ANY($1::${pkType}[])`,
          [rest.map((r) => r.pk)],
        );
        const want = new Map(rest.map((r) => [r.pk, r.fp]));
        for (const p of present.rows) (want.get(p.pk) === p.fp ? held++ : drifted++);
      }
      out[table] = {
        requested: rows.length,
        deleted: deleted.size,
        drifted,
        held,
        missing: rest.length - drifted - held,
        deletedPks: [...deleted],
      };
    }
    if (opts.beforeCommit) await opts.beforeCommit();
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  }
}
