/**
 * PROTOTYPE / SYNTHETIC DATA ONLY.
 * Foreign-key dependency graph discovered from pg_constraint — never hard-coded.
 */
import { createHash } from "node:crypto";
import type pg from "pg";

export type FkAction = "NO ACTION" | "RESTRICT" | "CASCADE" | "SET NULL" | "SET DEFAULT";
const ACTION: Record<string, FkAction> = { a: "NO ACTION", r: "RESTRICT", c: "CASCADE", n: "SET NULL", d: "SET DEFAULT" };

export interface FkEdge {
  name: string;
  child: string; // referencing table
  childColumns: string[];
  parent: string; // referenced table
  parentColumns: string[];
  onDelete: FkAction;
}

export async function discoverEdges(c: pg.Client): Promise<FkEdge[]> {
  const r = await c.query(`
    SELECT con.conname AS name,
           con.conrelid::regclass::text AS child,
           con.confrelid::regclass::text AS parent,
           con.confdeltype AS deltype,
           ARRAY(SELECT attname FROM unnest(con.conkey) WITH ORDINALITY k(n, o)
                 JOIN pg_attribute ON attrelid = con.conrelid AND attnum = k.n ORDER BY o)::text[] AS child_cols,
           ARRAY(SELECT attname FROM unnest(con.confkey) WITH ORDINALITY k(n, o)
                 JOIN pg_attribute ON attrelid = con.confrelid AND attnum = k.n ORDER BY o)::text[] AS parent_cols
    FROM pg_constraint con
    WHERE con.contype = 'f'
      AND con.connamespace NOT IN ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)
    ORDER BY 1`);
  const norm = (t: string) => (t.includes(".") ? t : `public.${t}`);
  return r.rows.map((x) => ({
    name: x.name,
    child: norm(x.child),
    parent: norm(x.parent),
    childColumns: x.child_cols,
    parentColumns: x.parent_cols,
    onDelete: ACTION[x.deltype]!,
  }));
}

export function graphHash(edges: FkEdge[]): string {
  return createHash("sha256").update(JSON.stringify([...edges].sort((a, b) => a.name.localeCompare(b.name)))).digest("hex");
}

/** Strongly-connected components with more than one node, or self-loops = cycles. */
export function findCycles(tables: string[], edges: FkEdge[]): string[][] {
  const nodes = new Set(tables);
  const adj = new Map<string, string[]>();
  for (const t of nodes) adj.set(t, []);
  for (const e of edges) if (nodes.has(e.child) && nodes.has(e.parent)) adj.get(e.child)!.push(e.parent);
  let index = 0;
  const idx = new Map<string, number>(), low = new Map<string, number>(), on = new Set<string>(), stack: string[] = [];
  const out: string[][] = [];
  const visit = (v: string) => {
    idx.set(v, index); low.set(v, index); index++; stack.push(v); on.add(v);
    for (const w of adj.get(v)!) {
      if (!idx.has(w)) { visit(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = [];
      let w: string;
      do { w = stack.pop()!; on.delete(w); comp.push(w); } while (w !== v);
      const selfLoop = edges.some((e) => e.child === v && e.parent === v);
      if (comp.length > 1 || selfLoop) out.push(comp.sort());
    }
  };
  for (const t of nodes) if (!idx.has(t)) visit(t);
  return out;
}

/**
 * Safe deletion order for a selected group: a table may be deleted only after every
 * selected table that references it. Derived from the edges (Kahn's algorithm).
 */
export function deletionOrder(selected: string[], edges: FkEdge[]): string[] {
  const inGroup = edges.filter((e) => selected.includes(e.child) && selected.includes(e.parent) && e.child !== e.parent);
  const remaining = new Set(selected);
  const order: string[] = [];
  while (remaining.size > 0) {
    // a table is ready when no remaining table references it
    const ready = [...remaining].filter((t) => !inGroup.some((e) => e.parent === t && remaining.has(e.child))).sort();
    if (ready.length === 0) throw new Error(`cycle among ${[...remaining].join(", ")}`);
    for (const t of ready) { order.push(t); remaining.delete(t); }
  }
  return order;
}

export type GroupIssue =
  | { kind: "cycle"; tables: string[] }
  | { kind: "unselected_child_cascade"; edge: FkEdge }
  | { kind: "unselected_child_set_null"; edge: FkEdge }
  | { kind: "unselected_child_blocks"; edge: FkEdge }
  | { kind: "child_without_parent"; edge: FkEdge };

/**
 * Validate a table selection against the discovered graph.
 * - CASCADE / SET NULL / SET DEFAULT edges from a selected parent to an unselected child → BLOCK (silent loss/modification)
 * - NO ACTION / RESTRICT edges to an unselected child → BLOCK (deletion would fail; or orphan logic needed)
 * - selected child whose parent is unselected → WARNING (allowed; parents stay behind)
 */
export function validateSelection(selected: string[], edges: FkEdge[]): { blocking: GroupIssue[]; warnings: GroupIssue[] } {
  const blocking: GroupIssue[] = [];
  const warnings: GroupIssue[] = [];
  for (const cyc of findCycles(selected, edges)) blocking.push({ kind: "cycle", tables: cyc });
  for (const e of edges) {
    const parentSel = selected.includes(e.parent);
    const childSel = selected.includes(e.child);
    if (parentSel && !childSel) {
      if (e.onDelete === "CASCADE") blocking.push({ kind: "unselected_child_cascade", edge: e });
      else if (e.onDelete === "SET NULL" || e.onDelete === "SET DEFAULT") blocking.push({ kind: "unselected_child_set_null", edge: e });
      else blocking.push({ kind: "unselected_child_blocks", edge: e });
    }
    if (childSel && !parentSel) warnings.push({ kind: "child_without_parent", edge: e });
  }
  return { blocking, warnings };
}
