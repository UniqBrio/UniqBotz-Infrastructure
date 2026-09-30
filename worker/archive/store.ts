import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Archive destination abstraction. Phase 3B ships ONLY a local-directory store (test destination).
 * The final provider is undecided (ADR Q-L1); an S3-compatible implementation must honour this contract.
 */
export interface StoredObject {
  key: string;
  bytes: number;
  sha256: string;
}

export interface ArchiveStore {
  readonly kind: "local-directory";
  readonly description: string;
  put(key: string, body: Readable): Promise<StoredObject>;
  head(key: string): Promise<{ bytes: number } | null>;
  get(key: string): Readable;
  removePrefix(prefix: string): Promise<void>;
  uri(key: string): string;
}

export class LocalDirectoryStore implements ArchiveStore {
  readonly kind = "local-directory" as const;
  readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }
  get description() {
    return `local directory ${this.root} (TEST DESTINATION — not an archive provider)`;
  }
  private path(key: string) {
    if (key.includes("..")) throw new Error("invalid object key");
    return join(this.root, key);
  }
  async put(key: string, body: Readable): Promise<StoredObject> {
    const p = this.path(key);
    mkdirSync(dirname(p), { recursive: true });
    const h = createHash("sha256");
    let bytes = 0;
    await pipeline(
      body,
      new Transform({ transform(chunk: Buffer, _e, cb) { h.update(chunk); bytes += chunk.length; cb(null, chunk); } }),
      createWriteStream(p),
    );
    return { key, bytes, sha256: h.digest("hex") };
  }
  async head(key: string) {
    const p = this.path(key);
    return existsSync(p) ? { bytes: statSync(p).size } : null;
  }
  get(key: string): Readable {
    return createReadStream(this.path(key));
  }
  async removePrefix(prefix: string) {
    rmSync(this.path(prefix), { recursive: true, force: true });
  }
  uri(key: string) {
    return `file://${this.path(key)}`;
  }
}
