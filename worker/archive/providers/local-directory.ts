import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  ArchivePurgeDisabledError, ArchiveStorageError, type ArchiveStorage, type ObjectMetadata, type ObjectVersion, type PurgeAuthorization, type StoredObject,
} from "../storage";

/**
 * Local-directory TEST DESTINATION. Not an archive provider: no durability, no versioning, no access control.
 * Approved for SYNTHETIC applications only.
 */
export class LocalDirectoryStorage implements ArchiveStorage {
  readonly provider = "local-directory" as const;
  readonly capabilities = { versioning: false, serverSideChecksum: false, objectLock: false };
  readonly approvedEnvironments = ["synthetic"] as const;
  readonly root: string;
  constructor(root: string, private opts: { purgeEnabled?: boolean } = {}) {
    this.root = resolve(root);
  }
  get description() {
    return `local directory ${this.root} (TEST DESTINATION — not an archive provider)`;
  }
  private path(key: string) {
    if (key.split("/").includes("..") || key.startsWith("/")) throw new Error("invalid object key");
    return join(this.root, key);
  }
  async upload(key: string, body: Readable): Promise<StoredObject> {
    const p = this.path(key);
    try {
      mkdirSync(dirname(p), { recursive: true });
      const h = createHash("sha256");
      let bytes = 0;
      await pipeline(body, new Transform({ transform(chunk: Buffer, _e, cb) { h.update(chunk); bytes += chunk.length; cb(null, chunk); } }), createWriteStream(p));
      return { key, bytes, sha256: h.digest("hex"), versionId: null };
    } catch (e) {
      throw new ArchiveStorageError("upload", key, e);
    }
  }
  read(key: string): Readable {
    return createReadStream(this.path(key));
  }
  async exists(key: string) {
    return existsSync(this.path(key));
  }
  async metadata(key: string): Promise<ObjectMetadata | null> {
    const p = this.path(key);
    if (!existsSync(p)) return null;
    const st = statSync(p);
    return { key, bytes: st.size, sha256: null, versionId: null, lastModified: st.mtime.toISOString(), userMetadata: {} };
  }
  async checksum(key: string) {
    const h = createHash("sha256");
    for await (const chunk of this.read(key)) h.update(chunk as Buffer);
    return h.digest("hex");
  }
  async versions(key: string): Promise<ObjectVersion[]> {
    const m = await this.metadata(key);
    return m ? [{ versionId: "local", bytes: m.bytes, lastModified: m.lastModified, isLatest: true }] : [];
  }
  async discardSupersededAttempt(prefix: string) {
    if (!/\/attempt-\d+$/.test(prefix)) throw new Error(`refusing to discard ${prefix}: not an export-attempt prefix`);
    rmSync(this.path(prefix), { recursive: true, force: true });
  }
  async purge(prefix: string, authorization: PurgeAuthorization) {
    if (!this.opts.purgeEnabled || !authorization?.authorizedBy || !authorization.policyReference) throw new ArchivePurgeDisabledError();
    const p = this.path(prefix);
    const count = (d: string): number => (existsSync(d) ? (statSync(d).isDirectory() ? readdirSync(d).reduce((s, f) => s + count(join(d, f)), 0) : 1) : 0);
    const removed = count(p);
    rmSync(p, { recursive: true, force: true });
    return { removed };
  }
  uri(key: string) {
    return `file://${this.path(key)}`;
  }
}
