import { createHash } from "node:crypto";
import type pg from "pg";
import type { CandidateKey } from "../archive/exporter";
import type { KeyRow } from "../deletion/batch";

export function chunkDigest(keys: CandidateKey[]): string {
  const h = createHash("sha256");
  for (const k of keys) h.update(`${k.pk}\t${k.fp}\t${k.parentKey ?? ""}\n`);
  return h.digest("hex");
}

export async function saveCandidateChunk(cp: pg.Client, jobId: string, attempt: number, table: string, chunkNo: number, keys: CandidateKey[]) {
  await cp.query(
    `INSERT INTO control.archive_job_candidates (job_id, attempt, table_name, chunk_no, row_count, pks, fingerprints, parent_keys, chunk_sha256)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [jobId, attempt, table, chunkNo, keys.length, keys.map((k) => k.pk), keys.map((k) => k.fp),
      keys.some((k) => k.parentKey !== null) ? keys.map((k) => k.parentKey) : null, chunkDigest(keys)]);
}

/** Load the exact frozen candidate set, re-checking every chunk digest. */
export async function loadCandidates(cp: pg.Client, jobId: string, attempt: number): Promise<{ keys: Record<string, KeyRow[]>; intact: boolean }> {
  const r = await cp.query(
    `SELECT table_name, chunk_no, pks, fingerprints, parent_keys, chunk_sha256, row_count FROM control.archive_job_candidates
     WHERE job_id = $1 AND attempt = $2 ORDER BY table_name, chunk_no`, [jobId, attempt]);
  const keys: Record<string, KeyRow[]> = {};
  let intact = r.rowCount! > 0;
  for (const row of r.rows) {
    const chunk: CandidateKey[] = (row.pks as string[]).map((pk, i) => ({ pk, fp: row.fingerprints[i], parentKey: row.parent_keys ? row.parent_keys[i] : null }));
    if (chunkDigest(chunk) !== row.chunk_sha256 || chunk.length !== row.row_count) intact = false;
    (keys[row.table_name] ??= []).push(...chunk);
  }
  return { keys, intact };
}

export function toMaps(keys: Record<string, KeyRow[]>): Record<string, Map<string, string>> {
  return Object.fromEntries(Object.entries(keys).map(([t, rows]) => [t, new Map(rows.map((r) => [r.pk, r.fp]))]));
}
