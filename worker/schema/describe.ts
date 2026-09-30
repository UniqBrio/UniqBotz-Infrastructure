import { createHash } from "node:crypto";
import type pg from "pg";

export interface ColumnInfo {
  name: string;
  type: string; // format_type()
  notNull: boolean;
  default: string | null;
}

export interface TableSchema {
  table: string; // schema-qualified, e.g. public.orders
  columns: ColumnInfo[];
  primaryKey: string[];
  constraints: { name: string; type: string; definition: string }[];
  triggers: { name: string; definition: string }[];
  rls: { enabled: boolean; forced: boolean; policies: number };
  owner: string;
}

export async function describeTable(c: pg.Client, table: string): Promise<TableSchema> {
  const rel = (await c.query(
    `SELECT oid, pg_get_userbyid(relowner) AS owner, relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = to_regclass($1)`,
    [table],
  )).rows[0];
  if (!rel) throw new Error(`table not found: ${table}`);
  const columns = (await c.query(
    `SELECT attname AS name, format_type(atttypid, atttypmod) AS type, attnotnull AS "notNull",
            pg_get_expr(d.adbin, d.adrelid) AS default
     FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE attrelid = $1 AND attnum > 0 AND NOT attisdropped ORDER BY attnum`, [rel.oid])).rows as ColumnInfo[];
  const primaryKey = (await c.query(
    `SELECT a.attname FROM pg_index i
     JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum, ord) ON true
     JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
     WHERE i.indrelid = $1 AND i.indisprimary ORDER BY k.ord`, [rel.oid])).rows.map((r) => r.attname as string);
  const constraints = (await c.query(
    `SELECT conname AS name, contype::text AS type, pg_get_constraintdef(oid) AS definition
     FROM pg_constraint WHERE conrelid = $1 ORDER BY conname`, [rel.oid])).rows;
  const triggers = (await c.query(
    `SELECT tgname AS name, pg_get_triggerdef(oid) AS definition FROM pg_trigger
     WHERE tgrelid = $1 AND NOT tgisinternal ORDER BY tgname`, [rel.oid])).rows;
  const policies = Number((await c.query(`SELECT count(*) n FROM pg_policy WHERE polrelid = $1`, [rel.oid])).rows[0].n);
  return {
    table,
    columns,
    primaryKey,
    constraints,
    triggers,
    rls: { enabled: rel.relrowsecurity, forced: rel.relforcerowsecurity, policies },
    owner: rel.owner,
  };
}

/**
 * Canonical hash over everything that would invalidate an archive or a deletion
 * (columns incl. names/types/order, PK, constraints incl. FKs, triggers, RLS).
 * Phase 3A P8: renames, type changes and constraint changes are INVISIBLE to row fingerprints,
 * so this hash is mandatory.
 */
export function schemaHash(schemas: TableSchema[]): string {
  const canonical = schemas
    .map((s) => ({ t: s.table, c: s.columns, pk: s.primaryKey, k: s.constraints, tr: s.triggers, rls: s.rls }))
    .sort((a, b) => a.t.localeCompare(b.t));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
