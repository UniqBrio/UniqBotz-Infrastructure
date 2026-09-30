/**
 * PROTOTYPE / SYNTHETIC DATA ONLY — P5 Archive verification under deliberate corruption (ADR §10, D-13).
 * Every corruption must end in: ARCHIVE VERIFICATION FAILED → DELETE = 0.
 */
import { createHash } from "node:crypto";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { DBS, connect, ms, now } from "./lib/db.ts";
import { exportGroup, type Manifest } from "./lib/archive.ts";
import { buildContext, deleteBatch, expandBatch, rootBatches } from "./lib/deleter.ts";
import { planGroup, selectCandidate } from "./lib/group.ts";
import { Recorder } from "./lib/results.ts";
import { assertDeletable, expectationFrom, verifyArchive, type ExpectedRecord, type VerificationResult } from "./lib/verify.ts";

const rec = new Recorder("p5-verification", "P5 — Archive verification");
const c = await connect(DBS.rosifit);
const table = "public.attendance_records";
const plan = await planGroup(c, { applicationId: "rosifit-synth", database: DBS.rosifit, root: table, dateColumn: "attendance_date",
  tables: [table], timeZone: "Asia/Kolkata", cutoffDay: "2025-09-30", target: 125_000 });
const sel = await selectCandidate(c, plan);
rec.measure("selection", { oldest: sel.oldestDate, boundary: sel.boundaryDate, total: sel.totalSelected, beforeFinal: sel.totalBeforeFinalDay, finalDay: sel.finalDayCount });

const jobId = "P5-" + Date.now();
let t = now();
const good = await exportGroup(c, plan, sel, jobId, 1);
rec.measure("export_125k_ms", Math.round(ms(t)));
rec.measure("archive_bytes", { data: good.manifest.tables[table]!.data.bytes, keys: good.manifest.tables[table]!.keys.bytes });
const expected = expectationFrom(good.manifest, good.manifestSha256);

t = now();
const base = await verifyArchive(good.dir, expected, { restoreCheck: false });
rec.measure("verify_V1_V6_ms", Math.round(ms(t)));
t = now();
const full = await verifyArchive(good.dir, expected);
rec.measure("verify_V1_V8_ms", Math.round(ms(t)));
rec.check("pristine archive passes V1–V6", true, base.passed);
rec.check("pristine archive passes V1–V8 (incl. restore + fingerprint)", true, full.passed);

const rowsBefore = Number((await c.query(`SELECT count(*) n FROM ${table}`)).rows[0].n);
const dataRel = good.manifest.tables[table]!.data.path;
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

/** Run the deletion gate exactly as the job runner does, return rows actually deleted. */
async function gateAndDelete(dir: string, v: VerificationResult, manifest: Manifest): Promise<number> {
  try {
    await assertDeletable(v);
  } catch {
    return 0; // gate refused — no DELETE statement is ever issued
  }
  const ctx = await buildContext(dir, manifest, plan.schemas, plan.edges);
  let n = 0; // gate open → REAL deletion of synthetic rows (each batch is its own committed transaction)
  for (const b of rootBatches(ctx, 2000)) n += (await deleteBatch(c, ctx, expandBatch(ctx, b)))[table]!.deleted;
  return n;
}

interface Case { name: string; mutate: (dir: string, exp: ExpectedRecord) => void; }
const cases: Case[] = [
  { name: "1 archive contents: flipped bytes inside data.csv.gz", mutate: (dir) => {
      const p = join(dir, dataRel); const b = readFileSync(p); for (let i = 0; i < 16; i++) b[Math.floor(b.length / 2) + i]! ^= 0xff; writeFileSync(p, b); } },
  { name: "2 checksum: control-plane sha256 for data file is wrong", mutate: (_dir, exp) => { exp.files[dataRel]!.sha256 = "0".repeat(64); } },
  { name: "3 row count: one row removed, archive re-gzipped and re-hashed consistently", mutate: (dir, exp) => {
      const p = join(dir, dataRel); const lines = gunzipSync(readFileSync(p)).toString("utf8").split("\n");
      lines.splice(1000, 1); const out = gzipSync(Buffer.from(lines.join("\n"))); writeFileSync(p, out);
      exp.files[dataRel] = { bytes: out.length, sha256: createHash("sha256").update(out).digest("hex") }; } },
  { name: "4 one row altered (value changed), archive re-gzipped and re-hashed consistently", mutate: (dir, exp) => {
      const p = join(dir, dataRel); const lines = gunzipSync(readFileSync(p)).toString("utf8").split("\n");
      const cols = lines[500]!.split(","); cols[2] = String(((Number(cols[2]) || 1) % 40) + 1); lines[500] = cols.join(",");
      const out = gzipSync(Buffer.from(lines.join("\n"))); writeFileSync(p, out);
      exp.files[dataRel] = { bytes: out.length, sha256: createHash("sha256").update(out).digest("hex") }; } },
  { name: "4b one row altered, checksums NOT updated", mutate: (dir) => {
      const p = join(dir, dataRel); const lines = gunzipSync(readFileSync(p)).toString("utf8").split("\n");
      lines[700] = lines[700]!.replace(/,(\d+),/, (_m, d) => `,${Number(d) + 1},`); writeFileSync(p, gzipSync(Buffer.from(lines.join("\n")))); } },
  { name: "5 metadata: manifest boundary edited", mutate: (dir) => {
      const p = join(dir, "manifest.json"); const m = JSON.parse(readFileSync(p, "utf8")); m.boundary.lastDay = "2099-01-01"; writeFileSync(p, JSON.stringify(m, null, 2)); } },
  { name: "5b metadata: manifest row count edited AND control-plane manifest hash re-recorded", mutate: (dir, exp) => {
      const p = join(dir, "manifest.json"); const m = JSON.parse(readFileSync(p, "utf8")); m.tables[table].rows += 1;
      const text = JSON.stringify(m, null, 2); writeFileSync(p, text); exp.manifestSha256 = createHash("sha256").update(text).digest("hex"); } },
  { name: "6 missing object: keys file deleted", mutate: (dir) => { rmSync(join(dir, good.manifest.tables[table]!.keys.path)); } },
];

const summary: Record<string, { failedChecks: string[]; deleted: number }> = {};
for (const k of cases) {
  const dir = `${good.dir}-case`;
  rmSync(dir, { recursive: true, force: true });
  cpSync(good.dir, dir, { recursive: true });
  const exp: ExpectedRecord = JSON.parse(JSON.stringify(expected));
  k.mutate(dir, exp);
  const v = await verifyArchive(dir, exp);
  const deleted = await gateAndDelete(dir, v, good.manifest);
  summary[k.name] = { failedChecks: v.checks.filter((x) => !x.pass).map((x) => x.id), deleted };
  rec.check(`${k.name} → VERIFICATION FAILED, DELETE = 0`, { passed: false, deleted: 0 }, { passed: v.passed, deleted });
  rmSync(dir, { recursive: true, force: true });
}
rec.measure("corruption_matrix", summary);
const onlyV8 = Object.entries(summary).filter(([, s]) => s.failedChecks.length > 0 && s.failedChecks.every((id) => id === "V8")).map(([n]) => n);
rec.measure("corruptions_caught_only_by_V8_restore_fingerprint", onlyV8);
rec.check("rows in source unchanged after all gate attempts", rowsBefore, Number((await c.query(`SELECT count(*) n FROM ${table}`)).rows[0].n));

// the pristine archive opens the gate: executed for real on synthetic data
const wouldDelete = await gateAndDelete(good.dir, full, good.manifest);
rec.check("pristine archive: gate opens and exactly the frozen rows are deleted (synthetic data, committed)", sel.totalSelected, wouldDelete);
await c.end();
rec.save();
