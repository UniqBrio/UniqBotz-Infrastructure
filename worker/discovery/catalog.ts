import type pg from "pg";
import { discoverEdges, type FkEdge } from "./fkGraph";

/**
 * Read-only catalog discovery for one application database. Never assumes `created_at` exists.
 * Every query here is catalog/statistics-only except exact row counts, which are opt-in per table.
 */
export interface DiscoveredColumn {
  name: string;
  ordinal: number;
  type: string;
  nullable: boolean;
  default: string | null;
  isDateCandidate: boolean;
}

export interface DiscoveredIndex {
  name: string;
  definition: string;
  isPrimary: boolean;
  isUnique: boolean;
}

export interface DiscoveredTable {
  schema: string;
  name: string;
  qualified: string;
  columns: DiscoveredColumn[];
  primaryKey: string[];
  indexes: DiscoveredIndex[];
  rls: { enabled: boolean; forced: boolean };
  estimatedRows: number;
  tableBytes: number;
  indexBytes: number;
  totalBytes: number;
  deadTuples: number | null;
  lastAutovacuum: string | null;
  dateCandidates: string[];
  /** A timestamp column whose DEFAULT is the insertion time — safe basis for growth. Null when none is provable. */
  insertionColumn: string | null;
}

export interface DiscoveryResult {
  schemas: string[];
  tables: DiscoveredTable[];
  foreignKeys: FkEdge[];
  databaseBytes: number;
  serverVersion: string;
  capturedAt: string;
}

const DATE_TYPES = new Set(["date", "timestamp with time zone", "timestamp without time zone"]);
const INSERTION_DEFAULT = /\b(now\(\)|CURRENT_TIMESTAMP|clock_timestamp\(\)|statement_timestamp\(\)|transaction_timestamp\(\)|timezone\('utc'::text, now\(\)\))/i;

export function isDateType(t: string) {
  return DATE_TYPES.has(t);
}

/** Insertion column = timestamp column defaulting to the current time. Name hints only break ties. */
export function pickInsertionColumn(columns: DiscoveredColumn[]): string | null {
  const candidates = columns.filter((c) => c.type.startsWith("timestamp") && c.default && INSERTION_DEFAULT.test(c.default));
  if (candidates.length === 0) return null;
  const preferred = candidates.find((c) => /^(created_at|inserted_at|created|creation_time)$/i.test(c.name));
  if (preferred) return preferred.name;
  return candidates.length === 1 ? candidates[0]!.name : null; // ambiguous → require explicit configuration
}

export async function discoverDatabase(c: pg.Client, opts: { schemas?: string[] } = {}): Promise<DiscoveryResult> {
  const schemas = opts.schemas ?? (await c.query(
    `SELECT nspname FROM pg_namespace
     WHERE nspname NOT IN ('pg_catalog','information_schema','pg_toast') AND nspname NOT LIKE 'pg_temp_%' AND nspname NOT LIKE 'pg_toast_temp_%'
       AND nspname NOT IN ('auth','storage','realtime','supabase_functions','supabase_migrations','extensions','graphql','graphql_public',
                           'pgbouncer','vault','net','cron','pgsodium','pgsodium_masks','_realtime','_analytics','pgmq','pgtle')
     ORDER BY 1`)).rows.map((r) => r.nspname as string);

  const rels = (await c.query(
    `SELECT c.oid, n.nspname AS schema, c.relname AS name, c.relrowsecurity AS rls, c.relforcerowsecurity AS rls_forced,
            GREATEST(c.reltuples, 0)::bigint AS est_rows,
            pg_relation_size(c.oid)::bigint AS table_bytes, pg_indexes_size(c.oid)::bigint AS index_bytes,
            pg_total_relation_size(c.oid)::bigint AS total_bytes,
            s.n_dead_tup::bigint AS dead, s.last_autovacuum
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     LEFT JOIN pg_stat_all_tables s ON s.relid = c.oid
     WHERE c.relkind IN ('r','p') AND n.nspname = ANY($1::text[])
     ORDER BY 2, 3`, [schemas])).rows;

  const cols = (await c.query(
    `SELECT a.attrelid AS oid, a.attname AS name, a.attnum AS ordinal, format_type(a.atttypid, a.atttypmod) AS type,
            NOT a.attnotnull AS nullable, pg_get_expr(d.adbin, d.adrelid) AS default
     FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = ANY($1::oid[]) AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attrelid, a.attnum`,
    [rels.map((r) => r.oid)])).rows;

  const idx = (await c.query(
    `SELECT i.indrelid AS oid, ic.relname AS name, pg_get_indexdef(i.indexrelid) AS definition, i.indisprimary AS primary, i.indisunique AS unique,
            ARRAY(SELECT a.attname FROM unnest(i.indkey) WITH ORDINALITY k(attnum, ord)
                  JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum ORDER BY k.ord)::text[] AS cols
     FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid WHERE i.indrelid = ANY($1::oid[]) ORDER BY 2`,
    [rels.map((r) => r.oid)])).rows;

  const tables: DiscoveredTable[] = rels.map((r) => {
    const columns: DiscoveredColumn[] = cols
      .filter((x) => x.oid === r.oid)
      .map((x) => ({ name: x.name, ordinal: x.ordinal, type: x.type, nullable: x.nullable, default: x.default, isDateCandidate: isDateType(x.type) }));
    const indexes = idx.filter((x) => x.oid === r.oid);
    const pk = indexes.find((x) => x.primary)?.cols ?? [];
    return {
      schema: r.schema,
      name: r.name,
      qualified: `${r.schema}.${r.name}`,
      columns,
      primaryKey: pk,
      indexes: indexes.map((x) => ({ name: x.name, definition: x.definition, isPrimary: x.primary, isUnique: x.unique })),
      rls: { enabled: r.rls, forced: r.rls_forced },
      estimatedRows: Number(r.est_rows),
      tableBytes: Number(r.table_bytes),
      indexBytes: Number(r.index_bytes),
      totalBytes: Number(r.total_bytes),
      deadTuples: r.dead === null ? null : Number(r.dead),
      lastAutovacuum: r.last_autovacuum ? new Date(r.last_autovacuum).toISOString() : null,
      dateCandidates: columns.filter((x) => x.isDateCandidate).map((x) => x.name),
      insertionColumn: pickInsertionColumn(columns),
    };
  });

  const edges = (await discoverEdges(c)).filter((e) => schemas.includes(e.child.split(".")[0]!) || schemas.includes(e.parent.split(".")[0]!));
  return {
    schemas,
    tables,
    foreignKeys: edges,
    databaseBytes: Number((await c.query(`SELECT pg_database_size(current_database())::bigint n`)).rows[0].n),
    serverVersion: (await c.query(`SHOW server_version`)).rows[0].server_version,
    capturedAt: new Date().toISOString(),
  };
}

/** Exact count — a full scan; used only for small tables or when an estimate is near a threshold. */
export async function exactRowCount(c: pg.Client, qualified: string): Promise<number> {
  const [schema, name] = qualified.split(".");
  return Number((await c.query(`SELECT count(*)::bigint n FROM "${schema!.replace(/"/g, '""')}"."${name!.replace(/"/g, '""')}"`)).rows[0].n);
}
