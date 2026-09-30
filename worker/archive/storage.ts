import type { Readable } from "node:stream";
import type { ApplicationEnvironment } from "../config";

/**
 * Provider-neutral archive storage (Phase 3C §7). The worker, exporter and verification gate depend ONLY on
 * this interface. Provider-specific code lives in ./providers/* and is selected by createArchiveStorage().
 *
 * NO FINAL PROVIDER IS CHOSEN (decision AR-1, legal Q-L1 data location). Only the local-directory TEST
 * destination is implemented, and it is approved for synthetic applications only. Anything else →
 * ARCHIVE EXECUTION UNAVAILABLE.
 */
export type ArchiveProviderId = "local-directory" | "s3-compatible" | "gcs" | "supabase-storage";

export interface StoredObject {
  key: string;
  bytes: number;
  sha256: string; // hex, computed while streaming the upload
  versionId?: string | null;
}

export interface ObjectMetadata {
  key: string;
  bytes: number;
  /** Provider-side checksum when the provider stores one (null when it must be computed by reading). */
  sha256: string | null;
  versionId: string | null;
  lastModified: string | null;
  userMetadata: Record<string, string>;
}

export interface ObjectVersion {
  versionId: string;
  bytes: number;
  lastModified: string | null;
  isLatest: boolean;
}

export interface StorageCapabilities {
  versioning: boolean;
  serverSideChecksum: boolean;
  objectLock: boolean;
}

/** Purging archived data is irreversible; it needs an explicit, recorded authorization and an enabled purge policy. */
export interface PurgeAuthorization {
  authorizedBy: string;
  reason: string;
  policyReference: string;
}

export interface ArchiveStorage {
  readonly provider: ArchiveProviderId;
  readonly description: string;
  readonly capabilities: StorageCapabilities;
  /** Application environments this destination is approved for. */
  readonly approvedEnvironments: readonly ApplicationEnvironment[];
  upload(key: string, body: Readable, userMetadata?: Record<string, string>): Promise<StoredObject>;
  read(key: string): Readable;
  exists(key: string): Promise<boolean>;
  metadata(key: string): Promise<ObjectMetadata | null>;
  /** SHA-256 (hex) of the stored bytes, computed by reading the object end to end. */
  checksum(key: string): Promise<string>;
  versions(key: string): Promise<ObjectVersion[]>;
  /** Remove the objects of a SUPERSEDED, never-verified export attempt of the worker's own job. */
  discardSupersededAttempt(prefix: string): Promise<void>;
  /** Remove verified archive data. Refused unless purge is enabled AND authorized (policy undecided: Q-B10). */
  purge(prefix: string, authorization: PurgeAuthorization): Promise<{ removed: number }>;
  uri(key: string): string;
}

export class ArchiveUnavailableError extends Error {
  constructor(why: string) {
    super(`ARCHIVE EXECUTION UNAVAILABLE: ${why}`);
    this.name = "ArchiveUnavailableError";
  }
}

export class ArchivePurgeDisabledError extends Error {
  constructor() {
    super("ARCHIVE PURGE DISABLED: archive retention/purge policy is not decided (Q-B10); no archive object was removed");
    this.name = "ArchivePurgeDisabledError";
  }
}

/** Raised by a provider when an operation fails (network, permission, missing object). Recoverable by the job runner. */
export class ArchiveStorageError extends Error {
  constructor(public operation: string, public key: string, cause: unknown) {
    super(`archive storage ${operation} failed for ${key}: ${String((cause as Error)?.message ?? cause)}`);
    this.name = "ArchiveStorageError";
  }
}

export function assertApprovedFor(storage: ArchiveStorage | null, environment: ApplicationEnvironment): ArchiveStorage {
  if (!storage) throw new ArchiveUnavailableError("no archive storage provider is configured (ARCHIVE_STORAGE_PROVIDER unset; decision AR-1)");
  if (!storage.approvedEnvironments.includes(environment)) {
    throw new ArchiveUnavailableError(`${storage.provider} is not approved for '${environment}' applications`);
  }
  return storage;
}
