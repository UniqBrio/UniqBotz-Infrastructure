/**
 * PROTOTYPE / SYNTHETIC DATA ONLY.
 * Freeze + export in ONE REPEATABLE READ READ ONLY snapshot (ADR D-03):
 *   data/<table>.csv.gz   Postgres COPY … CSV HEADER (the archive of record)
 *   keys/<table>.csv.gz   (pk, fingerprint[, parent_fk]) — the exact deletion manifest
 *   schema.json, manifest.json
 * "Archive storage" is a local directory standing in for an S3-compatible bucket (ADR P-7 remains open).
 */
import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import type pg from "pg";
import { to as copyTo } from "pg-copy-streams";
import { qi } from "./db.ts";
import { selectCandidate, tablePredicate, type GroupPlan, type SelectionResult } from "./group.ts";
import { FINGERPRINT } from "./schema.ts";

export interface FileEntry {
  path: string; // relative to attempt dir
  bytes: number;
  sha256: string; // of stored (compressed) bytes
  rawSha256: string; // of uncompressed bytes
  rows: number;
}

export interface Manifest {
  label: "PROTOTYPE / SYNTHETIC DATA ONLY";
  formatVersion: 1;
  jobId: string;
  attempt: number;
  applicationId: string;
  database: string;
  serverVersion: string;
  timeZone: string;
  root: string;
  dateColumn: string;
  cutoffDay: string;
  boundary: { firstDay: string | null; lastDay: string | null; endDayExclusive: string };
  /** Boundary of the read-only preview computed before the snapshot (may differ; the snapshot wins). */
  previewBoundary: string | null;
  target: number;
  days: { date: string; countsByTable: Record<string, number> }[];
  tables: Record<string, { pk: string; parentFk: string | null; rows: number; data: FileEntry; keys: FileEntry }>;
  fingerprint: { algorithm: "sha256(row::text)"; session: Record<string, string> };
  schemaHash: string;
  graphHash: string;
  deleteOrder: string[];
  snapshot: { isolation: string; exportMs: number; startedAt: string };
}

export const STORE_ROOT = new URL("../../.archive-store/", import.meta.url).pathname;

export function attemptDir(jobId: string, attempt: number) {
  return join(STORE_ROOT, jobId, `attempt-${attempt}`);
}

function hashTap(onDone: (hex: string, bytes: number, lines: number) => void, countLines = false) {
  const h = createHash("sha256");
  let bytes = 0;
  let lines = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      h.update(chunk);
      bytes += chunk.length;
      if (countLines) for (const b of chunk) if (b === 10) lines++;
      cb(null, chunk);
    },
    flush(cb) {
      onDone(h.digest("hex"), bytes, lines);
      cb();
    },
  });
}

async function copyToFile(c: pg.Client, sql: string, file: string): Promise<{ sha256: string; rawSha256: string; bytes: number }> {
  let raw = "";
  let gz = "";
  let bytes = 0;
  await pipeline(
    c.query(copyTo(sql)),
    hashTap((h) => (raw = h)),
    createGzip({ level: 6 }),
    hashTap((h, b) => { gz = h; bytes = b; }),
    createWriteStream(file),
  );
  return { sha256: gz, rawSha256: raw, bytes };
}

export interface ExportOptions {
  /** Called between tables — used by P7/P8 to inject crashes or concurrent changes. */
  betweenTables?: (table: string) => Promise<void>;
}

export async function exportGroup(
  c: pg.Client,
  plan: GroupPlan,
  preview: SelectionResult,
  jobId: string,
  attempt: number,
  opts: ExportOptions = {},
): Promise<{ manifest: Manifest; manifestSha256: string; dir: string; selection: SelectionResult }> {
  const dir = attemptDir(jobId, attempt);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "data"), { recursive: true });
  mkdirSync(join(dir, "keys"), { recursive: true });
  const startedAt = new Date().toISOString();
  const t0 = process.hrtime.bigint();
  const tables: Manifest["tables"] = {};

  await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  let selection: SelectionResult;
  try {
    // Whole-day selection is recomputed INSIDE the freeze snapshot (found in the late-data test):
    // the day totals, the boundary and the frozen rows then describe exactly the same set of rows.
    selection = await selectCandidate(c, plan);
    if (!selection.reachedTarget || !selection.endDayExclusive) throw new Error("target not reached inside the freeze snapshot");
    for (const table of plan.exportOrder) {
      const s = plan.schemas[table]!;
      const pk = s.primaryKey[0]!;
      const link = plan.links[table];
      const pred = tablePredicate(plan, table, selection.endDayExclusive!);
      const base = table.replace(/^public\./, "");
      const dataRel = `data/${base}.csv.gz`;
      const keysRel = `keys/${base}.csv.gz`;
      const data = await copyToFile(
        c,
        `COPY (SELECT t.* FROM ${qi(table)} t WHERE ${pred} ORDER BY t.${qi(pk)}) TO STDOUT WITH (FORMAT csv, HEADER)`,
        join(dir, dataRel),
      );
      const fkCol = link ? `, t.${qi(link.childColumns[0]!)}::text AS parent_fk` : "";
      const keys = await copyToFile(
        c,
        `COPY (SELECT t.${qi(pk)}::text AS pk, ${FINGERPRINT("t")} AS fp${fkCol} FROM ${qi(table)} t WHERE ${pred} ORDER BY t.${qi(pk)}) TO STDOUT WITH (FORMAT csv, HEADER)`,
        join(dir, keysRel),
      );
      const rows = Number((await c.query(`SELECT count(*) n FROM ${qi(table)} t WHERE ${pred}`)).rows[0].n);
      tables[table] = {
        pk,
        parentFk: link ? link.childColumns[0]! : null,
        rows,
        data: { path: dataRel, ...data, rows },
        keys: { path: keysRel, ...keys, rows },
      };
      if (opts.betweenTables) await opts.betweenTables(table);
    }
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  }
  const exportMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const serverVersion = (await c.query("SHOW server_version")).rows[0].server_version;

  writeFileSync(join(dir, "schema.json"), JSON.stringify(plan.schemas, null, 2));
  const manifest: Manifest = {
    label: "PROTOTYPE / SYNTHETIC DATA ONLY",
    formatVersion: 1,
    jobId,
    attempt,
    applicationId: plan.spec.applicationId,
    database: plan.spec.database,
    serverVersion,
    timeZone: plan.spec.timeZone,
    root: plan.spec.root,
    dateColumn: plan.spec.dateColumn,
    cutoffDay: plan.spec.cutoffDay,
    boundary: { firstDay: selection.oldestDate, lastDay: selection.boundaryDate, endDayExclusive: selection.endDayExclusive! },
    previewBoundary: preview.boundaryDate,
    target: plan.spec.target,
    days: selection.selectedDays,
    tables,
    fingerprint: {
      algorithm: "sha256(row::text)",
      session: { TimeZone: "UTC", DateStyle: "ISO, YMD", IntervalStyle: "postgres", extra_float_digits: "1", bytea_output: "hex" },
    },
    schemaHash: plan.schemaHash,
    graphHash: plan.graphHash,
    deleteOrder: plan.deleteOrder,
    snapshot: { isolation: "REPEATABLE READ READ ONLY", exportMs, startedAt },
  };
  const manifestText = JSON.stringify(manifest, null, 2);
  writeFileSync(join(dir, "manifest.json"), manifestText);
  const manifestSha256 = createHash("sha256").update(manifestText).digest("hex");
  return { manifest, manifestSha256, dir, selection };
}

export function fileSha256(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function fileSize(path: string) {
  return statSync(path).size;
}
