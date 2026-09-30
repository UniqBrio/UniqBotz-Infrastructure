/** Phase 3B names, kept as aliases. New code uses ./storage (ArchiveStorage) and ./providers. */
export type { ArchiveStorage as ArchiveStore, StoredObject } from "./storage";
export { LocalDirectoryStorage as LocalDirectoryStore } from "./providers/local-directory";
