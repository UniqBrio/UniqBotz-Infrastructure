import { createHash } from "node:crypto";
import { PassThrough, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { parse } from "csv-parse";
import type pg from "pg";
import { to as copyTo } from "pg-copy-streams";
import { PINNED_SESSION, qi } from "../connection/connect";
import { beginOwned } from "../connection/transaction";
import { selectCandidate, tablePredicate, type SelectionResult } from "../candidates/selection";
import type { GroupPlan } from "../retention/group";
import { FINGERPRINT_ALGORITHM, fingerprintSql } from "../schema/fingerprint";
import type { ArchiveFormat } from "./format";
import { MANIFEST_FORMAT_VERSION, type ArchiveManifest, type ManifestFile } from "./manifest";
import type { ArchiveStorage } from "./storage";

export interface CandidateKey {
  pk: string;
  fp: string;
  parentKey: string | null;
}

export interface ExportContext {
  jobId: string;
  attempt: number;
  store: ArchiveStorage;
  format: ArchiveFormat;
  softwareVersion: string;
  /** Receives the exact frozen keys in chunks (persisted as archive_job_candidates). */
  onKeys?: (table: string, chunkNo: number, keys: CandidateKey[]) => Promise<void>;
  chunkSize?: number;
  /** Test hook between tables (crash injection / concurrent change simulation). */
  betweenTables?: (table: string) => Promise<void>;
}

export interface ExportResult {
  schemaObject: { key: string; bytes: number; sha256: string };
  manifest: ArchiveManifest;
  manifestKey: string;
  manifestSha256: string;
  manifestBytes: number;
  selection: SelectionResult;
  prefix: string;
}

export class TargetNotReachedError extends Error {
  constructor() {
    super("target not reached inside the freeze snapshot — nothing frozen, no boundary proposed");
    this.name = "TargetNotReachedError";
  }
}

export function attemptPrefix(applicationId: string, jobId: string, attempt: number) {
  return `${applicationId}/${jobId}/attempt-${attempt}`;
}

function tap(onDone: (hex: string) => void) {
  const h = createHash("sha256");
  return new Transform({
    transform(chunk: Buffer, _e, cb) { h.update(chunk); cb(null, chunk); },
    flush(cb) { onDone(h.digest("hex")); cb(); },
  });
}

/**
 * FREEZE + EXPORT in ONE `REPEATABLE READ READ ONLY` snapshot (ADR D-03, Phase 3A F2):
 * the whole-day selection, the day totals, the exported rows and the frozen keys all describe
 * exactly the same rows. The delete identity is (PK, fingerprint) — never a date range.
 */
export async function freezeAndExport(c: pg.Client, plan: GroupPlan, preview: SelectionResult | null, ctx: ExportContext): Promise<ExportResult> {
  const prefix = attemptPrefix(plan.spec.applicationId, ctx.jobId, ctx.attempt);
  await ctx.store.discardSupersededAttempt(prefix);
  const startedAt = new Date().toISOString();
  const t0 = process.hrtime.bigint();
  const tables: ArchiveManifest["tables"] = {};
  const chunkSize = ctx.chunkSize ?? 2_000;

  await beginOwned(c, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  let selection: SelectionResult;
  try {
    selection = await selectCandidate(c, plan);
    if (!selection.reachedTarget || !selection.endDayExclusive) throw new TargetNotReachedError();
    for (const table of plan.exportOrder) {
      const s = plan.schemas[table]!;
      const pk = s.primaryKey[0]!;
      const link = plan.links[table];
      const pred = tablePredicate(plan, table, selection.endDayExclusive);
      const base = table.replace(/[^A-Za-z0-9_.-]/g, "_");

      // data (archive of record)
      let dataRaw = "";
      const dataStream = new PassThrough();
      const [, data] = await Promise.all([
        pipeline(
          c.query(copyTo(`COPY (SELECT t.* FROM ${qi(table)} t WHERE ${pred} ORDER BY t.${qi(pk)}) TO STDOUT WITH (${ctx.format.copyOutOptions})`)),
          tap((h) => (dataRaw = h)),
          createGzip({ level: 6 }),
          dataStream,
        ),
        ctx.store.upload(`${prefix}/data/${base}${ctx.format.extension}`, dataStream),
      ]);

      // keys (exact delete identity): pk, fingerprint[, parent key] — gzip to the store AND chunk to the control plane
      let keysRaw = "";
      const keyStream = new PassThrough();
      const tee = new PassThrough();
      const parser = parse({ from_line: 2 });
      tee.pipe(createGzip({ level: 6 })).pipe(keyStream);
      tee.pipe(parser);
      const keysPut = ctx.store.upload(`${prefix}/keys/${base}.keys.csv.gz`, keyStream);
      const parentCol = link ? `, t.${qi(link.childColumns[0]!)}::text AS parent_key` : "";
      const keysCopy = pipeline(
        c.query(copyTo(`COPY (SELECT t.${qi(pk)}::text AS pk, ${fingerprintSql("t")} AS fp${parentCol} FROM ${qi(table)} t WHERE ${pred} ORDER BY t.${qi(pk)}) TO STDOUT WITH (FORMAT csv, HEADER)`)),
        tap((h) => (keysRaw = h)),
        tee,
      );
      let rows = 0;
      let chunk: CandidateKey[] = [];
      let chunkNo = 0;
      for await (const r of parser as AsyncIterable<string[]>) {
        chunk.push({ pk: r[0]!, fp: r[1]!, parentKey: r[2] ?? null });
        rows++;
        if (chunk.length === chunkSize) { await ctx.onKeys?.(table, chunkNo++, chunk); chunk = []; }
      }
      if (chunk.length) await ctx.onKeys?.(table, chunkNo++, chunk);
      await keysCopy;
      const keys = await keysPut;

      const dataFile: ManifestFile = { key: data.key, bytes: data.bytes, sha256: data.sha256, rawSha256: dataRaw, rows };
      const keysFile: ManifestFile = { key: keys.key, bytes: keys.bytes, sha256: keys.sha256, rawSha256: keysRaw, rows };
      tables[table] = {
        table,
        role: table === plan.spec.root ? "root" : "child",
        primaryKey: pk,
        parentTable: link?.parent ?? null,
        parentFkColumn: link?.childColumns[0] ?? null,
        rows,
        data: dataFile,
        keys: keysFile,
        candidateKeys: { count: rows, fingerprintAlgorithm: FINGERPRINT_ALGORITHM, rawSha256: keysRaw },
      };
      if (ctx.betweenTables) await ctx.betweenTables(table);
    }
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  }
  const exportMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const info = (await c.query(`SELECT current_database() db, current_setting('server_version') v`)).rows[0];
  const manifest: ArchiveManifest = {
    formatVersion: MANIFEST_FORMAT_VERSION,
    softwareVersion: ctx.softwareVersion,
    jobId: ctx.jobId,
    attempt: ctx.attempt,
    applicationId: plan.spec.applicationId,
    sourceDatabase: info.db,
    serverVersion: info.v,
    createdAt: new Date().toISOString(),
    timeZone: plan.spec.timeZone,
    root: plan.spec.root,
    dateColumn: plan.spec.dateColumn,
    cutoffDay: plan.spec.cutoffDay,
    target: plan.spec.target,
    archiveFormat: ctx.format.id,
    boundary: { firstDay: selection.oldestDate!, lastDay: selection.boundaryDate!, endDayExclusive: selection.endDayExclusive! },
    previewBoundary: preview?.boundaryDate ?? null,
    days: selection.selectedDays,
    tables,
    fingerprint: { algorithm: FINGERPRINT_ALGORITHM, session: { ...PINNED_SESSION } },
    schemaHash: plan.schemaHash,
    graphHash: plan.graphHash,
    deleteOrder: plan.deleteOrder,
    snapshot: { isolation: "REPEATABLE READ READ ONLY", exportMs, startedAt },
  };
  const schemaObject = await ctx.store.upload(`${prefix}/schema.json`, PassThrough.from([Buffer.from(JSON.stringify(plan.schemas, null, 2))]));
  const text = JSON.stringify(manifest, null, 2);
  const manifestKey = `${prefix}/manifest.json`;
  const stored = await ctx.store.upload(manifestKey, PassThrough.from([Buffer.from(text)]));
  return { schemaObject, manifest, manifestKey, manifestSha256: stored.sha256, manifestBytes: stored.bytes, selection, prefix };
}
