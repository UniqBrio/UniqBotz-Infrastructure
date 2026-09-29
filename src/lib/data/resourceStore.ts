import type { InfrastructureDataSource } from "./source";

export type ResourceStatus = "loading" | "success" | "error";

export interface ResourceEntry<T = unknown> {
  status: ResourceStatus;
  data: T | undefined;
  error: Error | undefined;
  /** True while re-fetching with previous data still shown. */
  refreshing: boolean;
}

type Loader<T> = (source: InfrastructureDataSource) => Promise<T>;

/**
 * Minimal keyed cache for async reads (a tiny SWR). Entries are replaced
 * immutably so `useSyncExternalStore` snapshots stay referentially stable.
 * Mutations call `invalidateAll()` to re-run every loader, keeping the old data
 * visible while refreshing.
 */
export class ResourceStore {
  private entries = new Map<string, ResourceEntry>();
  private loaders = new Map<string, Loader<unknown>>();
  private inflight = new Map<string, number>();
  private listeners = new Set<() => void>();
  private seq = 0;

  constructor(private source: InfrastructureDataSource) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get(key: string): ResourceEntry | undefined {
    return this.entries.get(key);
  }

  private set(key: string, entry: ResourceEntry) {
    this.entries.set(key, entry);
    this.listeners.forEach((l) => l());
  }

  ensure<T>(key: string, loader: Loader<T>) {
    this.loaders.set(key, loader as Loader<unknown>);
    const existing = this.entries.get(key);
    if (existing && existing.status !== "error") return;
    if (this.inflight.has(key)) return;
    this.fetch(key);
  }

  private fetch(key: string) {
    const loader = this.loaders.get(key);
    if (!loader) return;
    const id = ++this.seq;
    this.inflight.set(key, id);
    const prev = this.entries.get(key);
    this.set(key, {
      status: prev?.data !== undefined ? "success" : "loading",
      data: prev?.data,
      error: undefined,
      refreshing: prev?.data !== undefined,
    });
    loader(this.source).then(
      (data) => {
        if (this.inflight.get(key) !== id) return;
        this.inflight.delete(key);
        this.set(key, { status: "success", data, error: undefined, refreshing: false });
      },
      (err: unknown) => {
        if (this.inflight.get(key) !== id) return;
        this.inflight.delete(key);
        this.set(key, {
          status: "error",
          data: undefined,
          error: err instanceof Error ? err : new Error(String(err)),
          refreshing: false,
        });
      },
    );
  }

  refetch(key: string) {
    this.fetch(key);
  }

  invalidateAll() {
    for (const key of this.loaders.keys()) this.fetch(key);
  }
}
