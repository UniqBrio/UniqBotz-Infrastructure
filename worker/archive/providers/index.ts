import { ArchiveUnavailableError, type ArchiveProviderId, type ArchiveStorage } from "../storage";
import { LocalDirectoryStorage } from "./local-directory";

/**
 * Provider registry. Selecting a provider is a business/legal decision (AR-1, Q-L1). Until an adapter for the
 * chosen provider is implemented and validated, requesting it yields ARCHIVE EXECUTION UNAVAILABLE.
 *
 *   ARCHIVE_STORAGE_PROVIDER   unset → no storage (ARCHIVE EXECUTION UNAVAILABLE)
 *                              local-directory → test destination (synthetic applications only)
 *                              s3-compatible | gcs | supabase-storage → recognised, NOT IMPLEMENTED
 *   ARCHIVE_STORE_DIR          local-directory root
 *   ARCHIVE_PURGE_ENABLED      purge stays disabled unless exactly "true" (and a purge policy exists)
 */
const PENDING: ArchiveProviderId[] = ["s3-compatible", "gcs", "supabase-storage"];

export function createArchiveStorage(env: Record<string, string | undefined> = process.env): ArchiveStorage | null {
  const provider = env.ARCHIVE_STORAGE_PROVIDER?.trim();
  if (!provider) return null;
  if (provider === "local-directory") {
    return new LocalDirectoryStorage(env.ARCHIVE_STORE_DIR ?? ".archive-store", { purgeEnabled: env.ARCHIVE_PURGE_ENABLED === "true" });
  }
  if ((PENDING as string[]).includes(provider)) {
    throw new ArchiveUnavailableError(`provider '${provider}' is not implemented — the archive provider is awaiting decision AR-1 / Q-L1`);
  }
  throw new ArchiveUnavailableError(`unknown archive storage provider '${provider}'`);
}

export { LocalDirectoryStorage };
