import crypto from 'crypto';

export interface CacheEntry<T> {
  key: string;
  data: T;
  expiresAt: number;
  tags: string[];
  createdAt: number;
}

export interface QueryCacheOptions {
  defaultTtlMs?: number;
  maxEntries?: number;
}

export interface QueryCacheStats {
  hits: number;
  misses: number;
  size: number;
  maxEntries: number;
  evictions: number;
}

export class QueryCache {
  private cache = new Map<string, CacheEntry<unknown>>();
  private tagIndex = new Map<string, Set<string>>();
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private readonly defaultTtlMs: number;
  private readonly maxEntries: number;

  constructor(options: QueryCacheOptions = {}) {
    this.defaultTtlMs = options.defaultTtlMs ?? 300000; // 5 min default
    this.maxEntries = options.maxEntries ?? 1000;
  }

  public generateKey(sql: string, params?: unknown[]): string {
    const raw = `${sql.trim()}::${JSON.stringify(params ?? [])}`;
    return crypto.createHash('sha256').update(raw).digest('hex');
  }

  public get<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }

    if (Date.now() > entry.expiresAt) {
      this.deleteEntry(key);
      this.misses++;
      return null;
    }

    this.hits++;
    return entry.data as T;
  }

  public set<T>(key: string, data: T, ttlMs?: number, tags: string[] = []): void {
    if (this.cache.size >= this.maxEntries && !this.cache.has(key)) {
      this.evictOldest();
    }

    const ttl = ttlMs ?? this.defaultTtlMs;
    const expiresAt = Date.now() + ttl;

    // Clean up old tags if updating existing key
    if (this.cache.has(key)) {
      this.removeKeyFromTags(key);
    }

    const entry: CacheEntry<T> = {
      key,
      data,
      expiresAt,
      tags,
      createdAt: Date.now(),
    };

    this.cache.set(key, entry as CacheEntry<unknown>);

    for (const tag of tags) {
      let set = this.tagIndex.get(tag);
      if (!set) {
        set = new Set<string>();
        this.tagIndex.set(tag, set);
      }
      set.add(key);
    }
  }

  public invalidateKey(key: string): boolean {
    return this.deleteEntry(key);
  }

  public invalidateTags(tags: string[]): number {
    let count = 0;
    const keysToDelete = new Set<string>();

    for (const tag of tags) {
      const keys = this.tagIndex.get(tag);
      if (keys) {
        for (const k of keys) {
          keysToDelete.add(k);
        }
        this.tagIndex.delete(tag);
      }
    }

    for (const key of keysToDelete) {
      if (this.cache.delete(key)) {
        count++;
      }
    }

    return count;
  }

  public clear(): void {
    this.cache.clear();
    this.tagIndex.clear();
  }

  public getStats(): QueryCacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      size: this.cache.size,
      maxEntries: this.maxEntries,
      evictions: this.evictions,
    };
  }

  private deleteEntry(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;

    this.removeKeyFromTags(key);
    return this.cache.delete(key);
  }

  private removeKeyFromTags(key: string): void {
    const entry = this.cache.get(key);
    if (!entry) return;

    for (const tag of entry.tags) {
      const set = this.tagIndex.get(tag);
      if (set) {
        set.delete(key);
        if (set.size === 0) {
          this.tagIndex.delete(tag);
        }
      }
    }
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.createdAt < oldestTime) {
        oldestTime = entry.createdAt;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.deleteEntry(oldestKey);
      this.evictions++;
    }
  }
}

export const queryCache = new QueryCache();
