import type { CandidateDay } from "../../src/lib/domain/types";

export const MANIFEST_FORMAT_VERSION = 2;

export interface ManifestFile {
  key: string; // object key in the archive store
  bytes: number; // stored (compressed) bytes
  sha256: string; // of stored bytes
  rawSha256: string; // of uncompressed bytes
  rows: number;
}

export interface ManifestTable {
  table: string;
  role: "root" | "child";
  primaryKey: string;
  parentTable: string | null;
  parentFkColumn: string | null;
  rows: number;
  data: ManifestFile;
  keys: ManifestFile;
  candidateKeys: { count: number; fingerprintAlgorithm: string; rawSha256: string };
}

export interface ArchiveManifest {
  formatVersion: number;
  softwareVersion: string;
  jobId: string;
  attempt: number;
  applicationId: string;
  sourceDatabase: string;
  serverVersion: string;
  createdAt: string;
  timeZone: string;
  root: string;
  dateColumn: string;
  cutoffDay: string;
  target: number;
  archiveFormat: string;
  boundary: { firstDay: string; lastDay: string; endDayExclusive: string };
  previewBoundary: string | null;
  days: CandidateDay[];
  tables: Record<string, ManifestTable>;
  fingerprint: { algorithm: string; session: Record<string, string> };
  schemaHash: string;
  graphHash: string;
  deleteOrder: string[];
  snapshot: { isolation: "REPEATABLE READ READ ONLY"; exportMs: number; startedAt: string };
}
