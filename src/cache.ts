/**
 * Async cache interface so the in-memory store can later be swapped for
 * Redis (or any shared store) without touching callers.
 */
export interface CacheStore<T> {
  get(key: string): Promise<T | undefined>;
  set(key: string, value: T, ttlMs: number, sizeBytes?: number): Promise<void>;
  delete(key: string): Promise<void>;
}

interface Entry<T> {
  value: T;
  expiresAt: number;
  sizeBytes: number;
}

/**
 * In-memory TTL cache with a total byte cap. Least-recently-used entries are
 * evicted when the cap is exceeded (Map iteration order + re-insertion on get
 * gives us LRU ordering for free).
 */
export class MemoryCache<T> implements CacheStore<T> {
  private entries = new Map<string, Entry<T>>();
  private totalBytes = 0;

  constructor(private readonly maxBytes: number) {}

  async get(key: string): Promise<T | undefined> {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.evict(key, entry);
      return undefined;
    }
    // Refresh recency.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  async set(key: string, value: T, ttlMs: number, sizeBytes = 0): Promise<void> {
    if (this.maxBytes > 0 && sizeBytes > this.maxBytes) return; // never fits; don't thrash
    const existing = this.entries.get(key);
    if (existing) this.evict(key, existing);
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs, sizeBytes });
    this.totalBytes += sizeBytes;
    if (this.maxBytes > 0) {
      for (const [k, e] of this.entries) {
        if (this.totalBytes <= this.maxBytes) break;
        if (k === key) continue; // never evict what we just inserted
        this.evict(k, e);
      }
    }
  }

  async delete(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (entry) this.evict(key, entry);
  }

  get size(): number {
    return this.entries.size;
  }

  private evict(key: string, entry: Entry<T>): void {
    this.entries.delete(key);
    this.totalBytes -= entry.sizeBytes;
  }
}
