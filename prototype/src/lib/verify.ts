/**
 * PROTOTYPE / SYNTHETIC DATA ONLY.
 * Archive verification V1–V6 + V8 (ADR §10). Expected values come from the CONTROL PLANE
 * record written at export time — never only from files stored next to the archive.
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { parse } from "csv-parse";
import type pg from "pg";
import { from as copyFrom } from "pg-copy-streams";
import { DBS, connect, qi } from "./db.ts";
import type { Manifest } from "./archive.ts";
import { FINGERPRINT, type TableSchema } from "./schema.ts";

export interface ExpectedRecord {
  manifestSha256: string;
  files: Record<string, { bytes: number; sha256: string }>; // relative path → stored bytes/hash
  rowsByTable: Record<string, number>;
  schemaHash: string;
  boundary: { firstDay: string | null; lastDay: string | null };
}

export interface VerificationResult {
  passed: boolean;
  checks: { id: string; name: string; pass: boolean; detail: string }[];
  ms: number;
}

async function readCsv(path: string, onRecord: (rec: string[], header: string[]) => void): Promise<number> {
  let header: string[] | null = null;
  let n = 0;
  const parser = parse({ relax_column_count: false });
  parser.on("data", (rec: string[]) => {
    if (!header) { header = rec; return; }
    n++;
    onRecord(rec, header);
  });
  await pipeline(createReadStream(path), createGunzip(), parser);
  return n;
}

export async function verifyArchive(dir: string, expected: ExpectedRecord, opts: { restoreCheck?: boolean } = {}): Promise<VerificationResult> {
  const t0 = process.hrtime.bigint();
  const checks: VerificationResult["checks"] = [];
  const add = (id: string, name: string, pass: boolean, detail: string) => checks.push({ id, name, pass, detail });
  const done = () => ({ passed: checks.length > 0 && checks.every((c) => c.pass), checks, ms: Number(process.hrtime.bigint() - t0) / 1e6 });

  // V1 existence + size
  const manifestPath = join(dir, "manifest.json");
  const missing = [manifestPath, ...Object.keys(expected.files).map((p) => join(dir, p))].filter((p) => !existsSync(p));
  add("V1", "objects exist", missing.length === 0, missing.length ? `missing: ${missing.join(", ")}` : "all present");
  if (missing.length) return done();
  const sizeBad = Object.entries(expected.files).filter(([p, f]) => statSync(join(dir, p)).size !== f.bytes);
  add("V1b", "object sizes match control plane", sizeBad.length === 0, sizeBad.map(([p]) => p).join(", ") || "ok");

  // V2 checksums vs control plane
  const manifestText = readFileSync(manifestPath, "utf8");
  const mSha = createHash("sha256").update(manifestText).digest("hex");
  add("V2a", "manifest sha256 = control-plane record", mSha === expected.manifestSha256, mSha.slice(0, 12));
  const shaBad = Object.entries(expected.files).filter(
    ([p, f]) => createHash("sha256").update(readFileSync(join(dir, p))).digest("hex") !== f.sha256,
  );
  add("V2b", "file sha256 = control-plane record", shaBad.length === 0, shaBad.map(([p]) => p).join(", ") || "ok");

  let manifest: Manifest;
  try {
    manifest = JSON.parse(manifestText) as Manifest;
  } catch (e) {
    add("V6", "manifest parses", false, String(e));
    return done();
  }

  // V6 manifest consistency vs control plane
  const mRows = Object.fromEntries(Object.entries(manifest.tables).map(([t, x]) => [t, x.rows]));
  const daysTotal = manifest.days.reduce((s, d) => s + Object.values(d.countsByTable).reduce((a, b) => a + b, 0), 0);
  const rowsTotal = Object.values(mRows).reduce((a, b) => a + b, 0);
  add("V6a", "manifest row counts = control plane", JSON.stringify(mRows) === JSON.stringify(expected.rowsByTable), JSON.stringify(mRows));
  add("V6b", "manifest schema hash = control plane", manifest.schemaHash === expected.schemaHash, manifest.schemaHash.slice(0, 12));
  add("V6c", "manifest boundary = control plane", manifest.boundary.firstDay === expected.boundary.firstDay && manifest.boundary.lastDay === expected.boundary.lastDay, JSON.stringify(manifest.boundary));
  add("V6d", "Σ day totals = Σ table rows (no rows outside selected days)", daysTotal === rowsTotal, `${daysTotal} vs ${rowsTotal}`);

  const schemas = JSON.parse(readFileSync(join(dir, "schema.json"), "utf8")) as Record<string, TableSchema>;
  for (const [table, t] of Object.entries(manifest.tables)) {
    const expectedRows = expected.rowsByTable[table];
    // V3 + V4 + V5 on data
    const dataPks: string[] = [];
    let dataRows = -1;
    try {
      dataRows = await readCsv(join(dir, t.data.path), (rec, header) => {
        dataPks.push(rec[header.indexOf(t.pk)]!);
      });
      add("V3", `${table}: data gunzip + CSV parse`, true, "ok");
    } catch (e) {
      add("V3", `${table}: data gunzip + CSV parse`, false, String(e).slice(0, 160));
      continue;
    }
    add("V4", `${table}: data row count = expected`, dataRows === expectedRows, `${dataRows} vs ${expectedRows}`);

    const keyFp = new Map<string, string>();
    let keyRows = -1;
    try {
      keyRows = await readCsv(join(dir, t.keys.path), (rec) => { keyFp.set(rec[0]!, rec[1]!); });
    } catch (e) {
      add("V3", `${table}: keys gunzip + CSV parse`, false, String(e).slice(0, 160));
      continue;
    }
    add("V4", `${table}: keys row count = expected`, keyRows === expectedRows && keyFp.size === keyRows, `${keyRows} rows, ${keyFp.size} unique`);
    const uniqueData = new Set(dataPks);
    const sameSet = uniqueData.size === dataPks.length && uniqueData.size === keyFp.size && dataPks.every((p) => keyFp.has(p));
    add("V5", `${table}: PK set data = keys, no duplicates`, sameSet, `${uniqueData.size} unique of ${dataPks.length}`);

    // V8 restore + fingerprint (content fidelity)
    if (opts.restoreCheck !== false) {
      const res = await restoreAndFingerprint(schemas[table]!, join(dir, t.data.path), t.pk);
      let mismatch = 0;
      for (const [pk, fp] of keyFp) if (res.get(pk) !== fp) mismatch++;
      add("V8", `${table}: restored rows fingerprint = keys`, mismatch === 0 && res.size === keyFp.size, `${mismatch} mismatches, ${res.size} restored`);
    }
  }
  return done();
}

/** Restore a data file into a scratch database table with the archived column types and fingerprint every row. */
export async function restoreAndFingerprint(schema: TableSchema, dataPath: string, pk: string): Promise<Map<string, string>> {
  const c = await connect(DBS.scratch);
  const name = `restore_${Math.random().toString(36).slice(2, 10)}`;
  try {
    const cols = schema.columns.map((col) => `${qi(col.name)} ${col.type}`).join(", ");
    await c.query(`CREATE TEMP TABLE ${name} (${cols})`);
    await pipeline(createReadStream(dataPath), createGunzip(), c.query(copyFrom(`COPY ${name} FROM STDIN WITH (FORMAT csv, HEADER)`)));
    const r = await c.query(`SELECT t.${qi(pk)}::text AS pk, ${FINGERPRINT("t")} AS fp FROM ${name} t`);
    return new Map(r.rows.map((x) => [x.pk, x.fp]));
  } finally {
    await c.end();
  }
}

export async function assertDeletable(v: VerificationResult | null | undefined): Promise<void> {
  if (!v || !v.passed) throw new Error("ARCHIVE VERIFICATION FAILED — DELETE = 0");
}

export type { pg };

/** Build the control-plane expectation from an export result (what the worker records at export time). */
export function expectationFrom(manifest: Manifest, manifestSha256: string): ExpectedRecord {
  return {
    manifestSha256,
    files: Object.fromEntries(
      Object.values(manifest.tables).flatMap((t) => [
        [t.data.path, { bytes: t.data.bytes, sha256: t.data.sha256 }],
        [t.keys.path, { bytes: t.keys.bytes, sha256: t.keys.sha256 }],
      ]),
    ),
    rowsByTable: Object.fromEntries(Object.entries(manifest.tables).map(([t, x]) => [t, x.rows])),
    schemaHash: manifest.schemaHash,
    boundary: { firstDay: manifest.boundary.firstDay, lastDay: manifest.boundary.lastDay },
  };
}
