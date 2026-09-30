/**
 * PROTOTYPE / SYNTHETIC DATA ONLY — P4 Archive format comparison (ADR §9, D-12).
 * Formats: CSV.GZ (COPY), JSONL.GZ (row_to_json), Parquet (@dsnp/parquetjs, typed mapping), XLSX (human-facing).
 * Fidelity = restore into an identical table and compare every column with IS NOT DISTINCT FROM.
 */
import { createReadStream, createWriteStream, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { parse } from "csv-parse";
import ExcelJS from "exceljs";
import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";
import { parquetWriteFile } from "hyparquet-writer";
import { from as copyFrom, to as copyTo } from "pg-copy-streams";
import { connect, ms, now } from "./lib/db.ts";
import { Recorder } from "./lib/results.ts";

const rec = new Recorder("p4-formats", "P4 — Archive format comparison");
const DB = "format_synth";
const OUT = new URL("../.scratch/p4/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const admin = await connect("postgres", { pin: false });
await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${DB}`);
await admin.end();
const c = await connect(DB);

const COLS = `
  id bigint PRIMARY KEY,
  n_exact numeric(20,6),
  n_any numeric,
  n_float double precision,
  ts timestamptz,
  ts_local timestamp,
  d date,
  flag boolean,
  u uuid,
  j jsonb,
  arr text[],
  blob bytea,
  txt_unicode text,
  txt_large text,
  empty_vs_null text,
  span interval`;
await c.query(`CREATE TABLE fidelity (${COLS})`);
await c.query(`SELECT setseed(0.99)`);
await c.query(`
INSERT INTO fidelity
SELECT g,
  CASE WHEN g % 97 = 0 THEN NULL ELSE (12345678901234 + g)::numeric + 0.123456 END,
  CASE WHEN g = 1 THEN 'NaN'::numeric WHEN g % 3 = 0 THEN 1e-20::numeric * g ELSE 98765432109876543210.0123456789 + g END,
  CASE WHEN g = 2 THEN 'Infinity'::float8 WHEN g % 5 = 0 THEN 0.1 + 0.2 ELSE g * 1.0000001e-300 END,
  timestamptz '2024-02-29 23:59:59.123456+05:30' + g * interval '1 second 7 microseconds',
  timestamp '2024-01-01 00:00:00.000001' + g * interval '1 minute',
  CASE WHEN g % 50 = 0 THEN NULL ELSE date '2023-01-01' + (g % 1000) END,
  CASE WHEN g % 7 = 0 THEN NULL ELSE g % 2 = 0 END,
  md5(g::text)::uuid,
  jsonb_build_object('seq', g, 'big', 9007199254740993, 'dec', 0.1, 'name', 'पनीर "टिक्का"', 'nested', jsonb_build_array(1, 'x', NULL)),
  ARRAY['plain', 'with,comma', 'with "quote"', NULL, E'multi\\nline'],
  CASE WHEN g % 11 = 0 THEN NULL ELSE decode(md5(g::text), 'hex') END,
  (ARRAY['Paneer Tikka', 'पनीर टिक्का', 'மசாலா தோசை', 'Filter Coffee ☕🙂', 'مرحبا', E'zero​width', E'tab\\tand\\nnewline', E'back\\\\slash "quote", comma'])[1 + g % 8],
  CASE WHEN g % 100 = 0 THEN repeat('Synthetic large text block — ', 2200) ELSE 'short' END,
  CASE WHEN g % 3 = 0 THEN '' WHEN g % 3 = 1 THEN NULL ELSE 'value' END,
  make_interval(days => g % 40, secs => g % 3600 + 0.5)
FROM generate_series(1, 100000) g`);
// A realistic narrow table (like order_items) for size/speed at volume
await c.query(`CREATE TABLE narrow AS
  SELECT g AS id, 1 + g / 3 AS order_id,
         (ARRAY['Paneer Tikka','पनीर टिक्का','மசாலா தோசை','Filter Coffee ☕','Veg Biryani'])[1 + g % 5] AS item_name,
         1 + g % 3 AS qty, round((40 + g % 400 + 0.5)::numeric, 2) AS unit_price,
         timestamptz '2024-01-01 11:00+05:30' + g * interval '37 seconds' AS created_at
  FROM generate_series(1, 750000) g;
  ALTER TABLE narrow ADD PRIMARY KEY (id);`);
await c.query("ANALYZE");


async function restoreTable(name: string, like: string) {
  await c.query(`DROP TABLE IF EXISTS ${name}; CREATE TABLE ${name} (LIKE ${like})`);
}

async function compare(src: string, dst: string, cols: string[]) {
  const exprs = cols.map((col) => `count(*) FILTER (WHERE s.${col} IS DISTINCT FROM d.${col})::int AS ${col}`).join(", ");
  const r = (await c.query(`SELECT count(d.id)::int restored, count(*)::int total, ${exprs} FROM ${src} s LEFT JOIN ${dst} d USING (id)`)).rows[0];
  const bad = Object.fromEntries(Object.entries(r).filter(([k, v]) => !["restored", "total"].includes(k) && (v as number) > 0));
  return { restored: r.restored as number, total: r.total as number, mismatchedColumns: bad };
}

type Fmt = "csv.gz" | "jsonl.gz" | "parquet" | "xlsx";
const results: Record<string, Record<Fmt, Record<string, unknown>>> = { fidelity: {} as never, narrow: {} as never };

// ---------------- CSV.GZ ----------------
async function csvRoundTrip(table: string) {
  const file = join(OUT, `${table}.csv.gz`);
  let t = now();
  await pipeline(c.query(copyTo(`COPY ${table} TO STDOUT WITH (FORMAT csv, HEADER)`)), createGzip({ level: 6 }), createWriteStream(file));
  const exportMs = ms(t);
  await restoreTable(`${table}_csv`, table);
  t = now();
  await pipeline(createReadStream(file), createGunzip(), c.query(copyFrom(`COPY ${table}_csv FROM STDIN WITH (FORMAT csv, HEADER)`)));
  return { exportMs, restoreMs: ms(t), bytes: statSync(file).size };
}

// ---------------- JSONL.GZ ----------------
// CSV mode with control-character QUOTE/DELIMITER streams raw JSON lines without COPY text escaping.
const RAW = `FORMAT csv, QUOTE e'\\x01', DELIMITER e'\\x02'`;
async function jsonlRoundTrip(table: string) {
  const file = join(OUT, `${table}.jsonl.gz`);
  let t = now();
  await pipeline(c.query(copyTo(`COPY (SELECT row_to_json(t)::text FROM ${table} t) TO STDOUT WITH (${RAW})`)), createGzip({ level: 6 }), createWriteStream(file));
  const exportMs = ms(t);
  await restoreTable(`${table}_jsonl`, table);
  t = now();
  await c.query(`CREATE TEMP TABLE jl_stage (j jsonb)`);
  await pipeline(createReadStream(file), createGunzip(), c.query(copyFrom(`COPY jl_stage FROM STDIN WITH (${RAW})`)));
  await c.query(`INSERT INTO ${table}_jsonl SELECT (jsonb_populate_record(NULL::${table}, j)).* FROM jl_stage`);
  await c.query(`DROP TABLE jl_stage`);
  return { exportMs, restoreMs: ms(t), bytes: statSync(file).size };
}

// ---------------- Parquet (hyparquet-writer, basic typed mapping a typical JS implementation would use) ----------------
function pqType(pgType: string): string {
  if (pgType === "bigint" || pgType === "integer") return "INT64";
  if (pgType.startsWith("numeric") || pgType === "double precision") return "DOUBLE";
  if (pgType.startsWith("timestamp")) return "TIMESTAMP";
  if (pgType === "boolean") return "BOOLEAN";
  if (pgType === "bytea") return "BYTE_ARRAY";
  if (pgType === "jsonb") return "JSON";
  return "STRING"; // date, uuid, text, arrays, interval
}
function toJs(v: string | null, pgType: string): unknown {
  if (v === null) return null;
  const t = pqType(pgType);
  if (t === "INT64") return BigInt(v);
  if (t === "DOUBLE") return Number(v);
  if (t === "TIMESTAMP") return new Date(pgType.includes("with time zone") ? v.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00") : v.replace(" ", "T") + "Z");
  if (t === "BOOLEAN") return v === "t";
  if (t === "BYTE_ARRAY") return new Uint8Array(Buffer.from(v.slice(2), "hex"));
  if (t === "JSON") return JSON.parse(v);
  return v;
}
function toPgText(v: unknown, pgType: string): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return pgType.includes("with time zone") ? v.toISOString() : v.toISOString().replace("Z", "");
  if (v instanceof Uint8Array) return "\\x" + Buffer.from(v).toString("hex");
  if (typeof v === "boolean") return v ? "t" : "f";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
function csvCell(v: string | null) {
  if (v === null) return "";
  return `"${v.replace(/"/g, '""')}"`;
}
async function parquetRoundTrip(table: string) {
  const cols = (await c.query(`SELECT attname, format_type(atttypid, atttypmod) t FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum`, [table])).rows as { attname: string; t: string }[];
  const file = join(OUT, `${table}.parquet`);
  let t = now();
  const data: unknown[][] = cols.map(() => []);
  // FORCE_QUOTE: non-NULL values are quoted, NULL is an unquoted empty field — keeps NULL vs '' distinct.
  const parser = parse({ from_line: 2, cast: (value, ctx) => (ctx.quoting ? value : value === "" ? null : value) });
  const done = pipeline(c.query(copyTo(`COPY ${table} TO STDOUT WITH (FORMAT csv, HEADER, FORCE_QUOTE *)`)), parser);
  for await (const row of parser as AsyncIterable<(string | null)[]>) {
    row.forEach((v, i) => data[i]!.push(toJs(v, cols[i]!.t)));
  }
  await done;
  await parquetWriteFile({ filename: file, columnData: cols.map((x, i) => ({ name: x.attname, data: data[i]!, type: pqType(x.t) as never })) });
  const exportMs = ms(t);
  await restoreTable(`${table}_parquet`, table);
  t = now();
  const rows = (await parquetReadObjects({ file: await asyncBufferFromFile(file), utf8: false })) as Record<string, unknown>[];
  const pass = new PassThrough();
  const load = pipeline(pass, c.query(copyFrom(`COPY ${table}_parquet FROM STDIN WITH (FORMAT csv)`)));
  for (const r of rows) pass.write(cols.map((x) => csvCell(toPgText(r[x.attname], x.t))).join(",") + "\n");
  pass.end();
  await load;
  return { exportMs, restoreMs: ms(t), bytes: statSync(file).size };
}

// ---------------- XLSX (human-facing only) ----------------
async function xlsxExport(table: string, limitRows: number) {
  const file = join(OUT, `${table}.xlsx`);
  const t = now();
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: file, useStyles: false, useSharedStrings: false });
  const ws = wb.addWorksheet(table);
  const parser = parse({ columns: true });
  const done = pipeline(c.query(copyTo(`COPY (SELECT * FROM ${table} ORDER BY id LIMIT ${limitRows}) TO STDOUT WITH (FORMAT csv, HEADER)`)), parser);
  let n = 0, truncatedCells = 0, first = true;
  for await (const row of parser as AsyncIterable<Record<string, string>>) {
    if (first) { ws.addRow(Object.keys(row)).commit(); first = false; }
    const vals = Object.values(row).map((v) => { if (v.length > 32767) { truncatedCells++; return v.slice(0, 32767); } return v; });
    ws.addRow(vals).commit();
    n++;
  }
  await done;
  await wb.commit();
  return { exportMs: ms(t), bytes: statSync(file).size, rows: n, cellsOverExcelLimit: truncatedCells };
}

const raw = async (table: string) => Number((await c.query(`SELECT sum(pg_column_size(t.*))::bigint n FROM ${table} t`)).rows[0].n);
for (const table of ["fidelity", "narrow"]) {
  const rows = Number((await c.query(`SELECT count(*) n FROM ${table}`)).rows[0].n);
  const cols = (await c.query(`SELECT attname FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum`, [table])).rows.map((r) => r.attname as string);
  rec.measure(`${table}_rows`, rows);
  rec.measure(`${table}_in_db_row_bytes`, await raw(table));
  const csv = await csvRoundTrip(table);
  const jsonl = await jsonlRoundTrip(table);
  const pq = await parquetRoundTrip(table);
  const xl = await xlsxExport(table, table === "fidelity" ? 100000 : 750000);
  for (const [fmt, m] of [["csv.gz", csv], ["jsonl.gz", jsonl], ["parquet", pq]] as const) {
    const fid = await compare(table, `${table}_${fmt.split(".")[0]}`, cols.filter((x) => x !== "id"));
    results[table]![fmt] = { bytes: m.bytes, exportMs: Math.round(m.exportMs), restoreMs: Math.round(m.restoreMs), ...fid };
  }
  results[table]!.xlsx = { bytes: xl.bytes, exportMs: Math.round(xl.exportMs), rows: xl.rows, cellsOverExcelLimit: xl.cellsOverExcelLimit, restore: "not an archival format; not restored" };
}
rec.measure("results", results);

const F = results.fidelity!;
rec.check("CSV.GZ round-trip exact for every column type", {}, F["csv.gz"].mismatchedColumns);
rec.check("CSV.GZ restores every row", 100000, F["csv.gz"].restored);
rec.measure("jsonl_mismatched_columns", F["jsonl.gz"].mismatchedColumns);
rec.measure("parquet_mismatched_columns", F["parquet"].mismatchedColumns);
rec.check("Parquet (typical typed JS mapping) is NOT lossless", true, Object.keys(F["parquet"].mismatchedColumns as object).length > 0);
rec.check("XLSX cannot hold large text cells (Excel 32,767-char limit)", true, (F.xlsx.cellsOverExcelLimit as number) > 0);
await c.end();
rec.save();
