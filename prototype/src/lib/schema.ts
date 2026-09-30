/**
 * PROTOTYPE / SYNTHETIC DATA ONLY.
 * Catalog introspection: columns, primary key, constraints, triggers, RLS, and a canonical schema hash.
 */
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
  const oid = (await c.query(`SELECT $1::regclass::oid AS oid, pg_get_userbyid(relowner) AS owner,
      relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = $1::regclass`, [table])).rows[0];
  if (!oid) throw new Error(`table not found: ${table}`);
  const columns = (
    await c.query(
      `SELECT attname AS name, format_type(atttypid, atttypmod) AS type, attnotnull AS "notNull",
              pg_get_expr(d.adbin, d.adrelid) AS default
       FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE attrelid = $1 AND attnum > 0 AND NOT attisdropped ORDER BY attnum`,
      [oid.oid],
    )
  ).rows as ColumnInfo[];
  const pk = (
    await c.query(
      `SELECT a.attname FROM pg_index i
       JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum, ord) ON true
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
       WHERE i.indrelid = $1 AND i.indisprimary ORDER BY k.ord`,
      [oid.oid],
    )
  ).rows.map((r) => r.attname as string);
  const constraints = (
    await c.query(
      `SELECT conname AS name, contype::text AS type, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint WHERE conrelid = $1 ORDER BY conname`,
      [oid.oid],
    )
  ).rows;
  const triggers = (
    await c.query(
      `SELECT tgname AS name, pg_get_triggerdef(oid) AS definition
       FROM pg_trigger WHERE tgrelid = $1 AND NOT tgisinternal ORDER BY tgname`,
      [oid.oid],
    )
  ).rows;
  const policies = Number((await c.query(`SELECT count(*) n FROM pg_policy WHERE polrelid = $1`, [oid.oid])).rows[0].n);
  return {
    table,
    columns,
    primaryKey: pk,
    constraints,
    triggers,
    rls: { enabled: oid.relrowsecurity, forced: oid.relforcerowsecurity, policies },
    owner: oid.owner,
  };
}

/** Canonical hash over everything that would make an archive or a deletion invalid. */
export function schemaHash(schemas: TableSchema[]): string {
  const canonical = schemas
    .map((s) => ({ t: s.table, c: s.columns, pk: s.primaryKey, k: s.constraints, tr: s.triggers, rls: s.rls }))
    .sort((a, b) => a.t.localeCompare(b.t));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function pkType(s: TableSchema): string {
  if (s.primaryKey.length !== 1) throw new Error(`${s.table}: prototype supports single-column primary keys only`);
  return s.columns.find((c) => c.name === s.primaryKey[0])!.type;
}

/** Row fingerprint (A-2): SHA-256 of the row's text representation under pinned session settings. */
export const FINGERPRINT = (alias: string) => `encode(sha256(convert_to(${alias}::text, 'UTF8')), 'hex')`;
export const FINGERPRINT_MD5 = (alias: string) => `md5(${alias}::text)`;
