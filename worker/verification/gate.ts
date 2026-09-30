import { createHash } from "node:crypto";
import { PassThrough, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { parse } from "csv-parse";
import type pg from "pg";
import { from as copyFrom } from "pg-copy-streams";
import { qi } from "../connection/connect";
import type { ArchiveFormat } from "../archive/format";
import type { ArchiveManifest } from "../archive/manifest";
import type { ArchiveStorage } from "../archive/storage";
import type { TableSchema } from "../schema/describe";
import { fingerprintSql } from "../schema/fingerprint";

/**
 * VERIFICATION GATE (Phase 3B §18). Stages run in this order; ANY failure → DELETE = 0.
 *   Archive Created → Archive Integrity → Archive Row Count → Archive Key Set
 *   → Restore + Fingerprint Reconciliation (FULL, never sampled — Phase 3A F3) → Schema Hash → VERIFIED
 * Expected values come from the CONTROL PLANE record written at export time, never only from files
 * stored next to the archive.
 */
export type GateStage = "archive_created" | "archive_integrity" | "archive_row_count" | "archive_key_set" | "restore_fingerprint" | "schema_hash";
export const GATE_ORDER: GateStage[] = ["archive_created", "archive_integrity", "archive_row_count", "archive_key_set", "restore_fingerprint", "schema_hash"];

export interface ExpectedArchive {
  jobId: string;
  attempt: number;
  applicationId: string;
  manifestKey: string;
  manifestSha256: string;
  files: Record<string, { bytes: number; sha256: string; rawSha256: string }>;
  rowsByTable: Record<string, number>;
  candidateKeyDigests: Record<string, string>; // table → sha256 of the raw keys stream at freeze time
  schemaHash: string;
  boundary: { firstDay: string; lastDay: string };
}

export interface GateCheck {
  stage: GateStage;
  name: string;
  pass: boolean;
  detail: string;
}

export interface GateResult {
  verified: boolean;
  failedStage: GateStage | null;
  checks: GateCheck[];
  ms: number;
  verifierVersion: string;
}

export interface GateInputs {
  store: ArchiveStorage;
  format: ArchiveFormat;
  expected: ExpectedArchive;
  /** Schema hash recomputed from the LIVE source right now (drift since freeze fails the gate). */
  currentSchemaHash: string;
  /** The exact frozen candidate set as persisted in the control plane (table → pk → fingerprint). */
  controlPlaneCandidates: Record<string, Map<string, string>>;
  /** Scratch database for the restore step (never the source database). */
  openScratch: () => Promise<pg.Client>;
  verifierVersion: string;
}

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks);
}

async function parseGzCsv(buf: Buffer, onRecord: (rec: string[], header: string[]) => void): Promise<{ rows: number; rawSha256: string }> {
  let header: string[] | null = null;
  let rows = 0;
  const h = createHash("sha256");
  const parser = parse();
  parser.on("data", (rec: string[]) => {
    if (!header) { header = rec; return; }
    rows++;
    onRecord(rec, header);
  });
  await pipeline(PassThrough.from([buf]), createGunzip(),
    new Transform({ transform(c: Buffer, _e, cb) { h.update(c); cb(null, c); } }), parser);
  return { rows, rawSha256: h.digest("hex") };
}

export async function runVerificationGate(inp: GateInputs): Promise<GateResult> {
  const t0 = process.hrtime.bigint();
  const checks: GateCheck[] = [];
  const exp = inp.expected;
  const add = (stage: GateStage, name: string, pass: boolean, detail: string) => { checks.push({ stage, name, pass, detail }); return pass; };
  const finish = (): GateResult => {
    const failed = GATE_ORDER.find((st) => checks.some((c) => c.stage === st && !c.pass)) ?? null;
    return { verified: failed === null && GATE_ORDER.every((st) => checks.some((c) => c.stage === st)), failedStage: failed,
      checks, ms: Number(process.hrtime.bigint() - t0) / 1e6, verifierVersion: inp.verifierVersion };
  };

  // 1. ARCHIVE CREATED — every object exists with the recorded size; manifest belongs to this job/attempt
  const keys = [exp.manifestKey, ...Object.keys(exp.files)];
  const heads = await Promise.all(keys.map(async (k) => [k, await inp.store.metadata(k)] as const));
  const missing = heads.filter(([, h]) => !h).map(([k]) => k);
  add("archive_created", "all objects exist", missing.length === 0, missing.length ? `missing: ${missing.join(", ")}` : `${keys.length} objects`);
  if (missing.length) return finish();
  const sizeBad = Object.entries(exp.files).filter(([k, f]) => heads.find(([hk]) => hk === k)![1]!.bytes !== f.bytes).map(([k]) => k);
  add("archive_created", "object sizes = control-plane record", sizeBad.length === 0, sizeBad.join(", ") || "ok");
  const manifestBuf = await readAll(inp.store.read(exp.manifestKey));
  let manifest: ArchiveManifest;
  try { manifest = JSON.parse(manifestBuf.toString("utf8")); } catch (e) { add("archive_created", "manifest parses", false, String(e)); return finish(); }
  add("archive_created", "manifest identifies this job, attempt and application",
    manifest.jobId === exp.jobId && manifest.attempt === exp.attempt && manifest.applicationId === exp.applicationId,
    `${manifest.jobId}#${manifest.attempt} ${manifest.applicationId}`);
  add("archive_created", "manifest boundary = control-plane record",
    manifest.boundary.firstDay === exp.boundary.firstDay && manifest.boundary.lastDay === exp.boundary.lastDay, JSON.stringify(manifest.boundary));
  if (checks.some((c) => !c.pass)) return finish();

  // 2. ARCHIVE INTEGRITY — checksums vs control plane, full gunzip of every object
  const mSha = createHash("sha256").update(manifestBuf).digest("hex");
  add("archive_integrity", "manifest sha256 = control-plane record", mSha === exp.manifestSha256, mSha.slice(0, 16));
  const buffers = new Map<string, Buffer>();
  for (const k of Object.keys(exp.files)) buffers.set(k, await readAll(inp.store.read(k)));
  const shaBad = Object.entries(exp.files).filter(([k, f]) => createHash("sha256").update(buffers.get(k)!).digest("hex") !== f.sha256).map(([k]) => k);
  add("archive_integrity", "object sha256 = control-plane record", shaBad.length === 0, shaBad.join(", ") || "ok");
  if (checks.some((c) => !c.pass)) return finish();

  const schemaKey = exp.manifestKey.replace(/manifest\.json$/, "schema.json");
  const schemas = JSON.parse(buffers.get(schemaKey)!.toString("utf8")) as Record<string, TableSchema>;
  const parsed: Record<string, { dataPks: string[]; keyFp: Map<string, string>; dataRows: number; keyRows: number; dataRaw: string; keyRaw: string }> = {};
  for (const [table, t] of Object.entries(manifest.tables)) {
    try {
      const dataPks: string[] = [];
      const d = await parseGzCsv(buffers.get(t.data.key)!, (rec, header) => dataPks.push(rec[header.indexOf(t.primaryKey)]!));
      const keyFp = new Map<string, string>();
      const k = await parseGzCsv(buffers.get(t.keys.key)!, (rec) => keyFp.set(rec[0]!, rec[1]!));
      parsed[table] = { dataPks, keyFp, dataRows: d.rows, keyRows: k.rows, dataRaw: d.rawSha256, keyRaw: k.rawSha256 };
      add("archive_integrity", `${table}: gunzip + parse`, true, "ok");
      add("archive_integrity", `${table}: uncompressed sha256 = recorded`, d.rawSha256 === exp.files[t.data.key]?.rawSha256 && k.rawSha256 === exp.files[t.keys.key]?.rawSha256, "data+keys");
    } catch (e) {
      add("archive_integrity", `${table}: gunzip + parse`, false, String(e).slice(0, 200));
    }
  }
  if (checks.some((c) => !c.pass)) return finish();

  // 3. ARCHIVE ROW COUNT — data rows, key rows, manifest rows and Σ day totals all equal the control plane
  for (const [table, p] of Object.entries(parsed)) {
    const want = exp.rowsByTable[table];
    add("archive_row_count", `${table}: data rows = control plane`, p.dataRows === want, `${p.dataRows} vs ${want}`);
    add("archive_row_count", `${table}: key rows = control plane`, p.keyRows === want && p.keyFp.size === p.keyRows, `${p.keyRows} (${p.keyFp.size} unique)`);
    add("archive_row_count", `${table}: manifest rows = control plane`, manifest.tables[table]!.rows === want, String(manifest.tables[table]!.rows));
  }
  const dayTotal = manifest.days.reduce((s, d) => s + Object.values(d.countsByTable).reduce((a, b) => a + b, 0), 0);
  const rowTotal = Object.values(exp.rowsByTable).reduce((a, b) => a + b, 0);
  add("archive_row_count", "Σ day totals = Σ rows (whole days only)", dayTotal === rowTotal, `${dayTotal} vs ${rowTotal}`);
  if (checks.some((c) => !c.pass)) return finish();

  // 4. ARCHIVE KEY SET — PKs in data = frozen keys, no duplicates, keys = the set frozen in the control plane
  for (const [table, p] of Object.entries(parsed)) {
    const unique = new Set(p.dataPks);
    const same = unique.size === p.dataPks.length && unique.size === p.keyFp.size && p.dataPks.every((k) => p.keyFp.has(k));
    add("archive_key_set", `${table}: data PK set = frozen key set, no duplicates`, same, `${unique.size} unique of ${p.dataPks.length}`);
    add("archive_key_set", `${table}: keys digest = digest recorded at freeze`, p.keyRaw === exp.candidateKeyDigests[table], p.keyRaw.slice(0, 16));
    const cpSet = inp.controlPlaneCandidates[table];
    let diff = cpSet ? Math.abs(cpSet.size - p.keyFp.size) : -1;
    if (cpSet) for (const [pk, fp] of p.keyFp) if (cpSet.get(pk) !== fp) diff++;
    add("archive_key_set", `${table}: archive keys = control-plane frozen candidates (PK + fingerprint)`, diff === 0, cpSet ? `${diff} differences` : "no control-plane candidates");
  }
  if (checks.some((c) => !c.pass)) return finish();

  // 5. RESTORE + FINGERPRINT RECONCILIATION — every row restored into a scratch DB, every fingerprint re-derived
  const scratch = await inp.openScratch();
  try {
    for (const [table, t] of Object.entries(manifest.tables)) {
      const name = `restore_${Math.random().toString(36).slice(2, 10)}`;
      const cols = schemas[table]!.columns.map((col) => `${qi(col.name)} ${col.type}`).join(", ");
      await scratch.query(`CREATE TEMP TABLE ${name} (${cols})`);
      await pipeline(PassThrough.from([buffers.get(t.data.key)!]), createGunzip(),
        scratch.query(copyFrom(`COPY ${name} FROM STDIN WITH (${inp.format.copyInOptions})`)));
      const r = await scratch.query(`SELECT t.${qi(t.primaryKey)}::text AS pk, ${fingerprintSql("t")} AS fp FROM ${name} t`);
      const keyFp = parsed[table]!.keyFp;
      let mismatch = 0;
      for (const row of r.rows) if (keyFp.get(row.pk) !== row.fp) mismatch++;
      add("restore_fingerprint", `${table}: restored rows = frozen rows`, r.rowCount === keyFp.size, `${r.rowCount} restored`);
      add("restore_fingerprint", `${table}: every restored fingerprint = frozen fingerprint`, mismatch === 0, `${mismatch} mismatches`);
      await scratch.query(`DROP TABLE ${name}`);
    }
  } catch (e) {
    add("restore_fingerprint", "restore into scratch database", false, String((e as Error).message).slice(0, 200));
  } finally {
    await scratch.end().catch(() => {});
  }
  if (checks.some((c) => !c.pass)) return finish();

  // 6. SCHEMA HASH — manifest = control plane = live source now
  add("schema_hash", "manifest schema hash = control plane", manifest.schemaHash === exp.schemaHash, manifest.schemaHash.slice(0, 16));
  add("schema_hash", "live source schema unchanged since freeze", inp.currentSchemaHash === exp.schemaHash, inp.currentSchemaHash.slice(0, 16));
  return finish();
}
