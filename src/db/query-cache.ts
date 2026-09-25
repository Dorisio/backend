import crypto from 'crypto';
import { collapseWhitespace } from './query-logger';

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
  /** Hard upper bound applied to any caller supplied TTL. */
  maxTtlMs?: number;
}

export interface QueryCacheStats {
  hits: number;
  misses: number;
  size: number;
  maxEntries: number;
  evictions: number;
  sets: number;
  deletes: number;
  hitRate: number;
  inflight: number;
}

export interface CacheLookup<T> {
  hit: boolean;
  value: T | null;
}

const DEFAULT_TTL_MS = 60_000; // 60s
const MAX_TTL_MS = 5 * 60_000; // 5 minutes
const MAX_ENTRIES = 1000;

const READ_ONLY_PREFIX = /^\s*(select|with|table|values|explain)\b/i;
const MUTATING_PREFIX = /^\s*(insert|update|delete|truncate|create|alter|drop|grant|revoke|call|do|copy|merge|vacuum|analyze|refresh|reindex|listen|notify|begin|commit|rollback|set|reset)\b/i;

/**
 * Detects statements that mutate data or session state. Those must never be
 * served from (or written to) a read cache.
 */
export function isReadOnlyQuery(sql: string): boolean {
  if (!sql || typeof sql !== 'string') return false;
  const withoutComments = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim();
  if (!withoutComments) return false;
  if (MUTATING_PREFIX.test(withoutComments)) return false;
  return READ_ONLY_PREFIX.test(withoutComments);
}

export class QueryCache {
  private cache = new Map<string, CacheEntry<unknown>>();
  private tagIndex = new Map<string, Set<string>>();
  private inflight = new Map<string, Promise<unknown>>();
  private hits = 0;
  private misses = 0;
  private sets = 0;
  private deletes = 0;
  private evictions = 0;
  private readonly defaultTtlMs: number;
  private readonly maxTtlMs: number;
  private readonly maxEntries: number;

  constructor(options: QueryCacheOptions = {}) {
    this.defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;
    this.maxTtlMs = options.maxTtlMs ?? MAX_TTL_MS;
    this.maxEntries = options.maxEntries ?? MAX_ENTRIES;
  }

  /**
   * Builds a stable cache key from the exact statement plus its bound
   * parameters. Whitespace is collapsed so that formatting differences do not
   * fragment the cache, but the literals themselves are kept verbatim: two
   * different statements must never share a key, or one would serve the other's
   * rows. (`normalizeSql` is the right tool for grouping in *logs* — literals
   * replaced by placeholders — but not for cache identity.)
   */
  public generateKey(sql: string, params?: unknown[] | Record<string, unknown>): string {
    let serialized: string;
    try {
      serialized = JSON.stringify(params ?? [], (_key, value) => {
        if (typeof value === 'bigint') return value.toString();
        if (value instanceof Date) return value.toISOString();
        return value;
      });
    } catch {
      serialized = String(params);
    }
    const raw = `${collapseWhitespace(sql)}\u0000${serialized ?? '[]'}`;
    return crypto.createHash('sha256').update(raw).digest('hex');
  }

  /**
   * Returns a value while distinguishing a cache miss from a cached `null`.
   */
  public lookup<T>(key: string): CacheLookup<T> {
    const entry = this.cache.get(key);
    if (!entry) {
      this.misses++;
      return { hit: false, value: null };
    }

    if (Date.now() > entry.expiresAt) {
      this.deleteEntry(key);
      this.misses++;
      return { hit: false, value: null };
    }

    // refresh insertion order for LRU-ish eviction
    this.cache.delete(key);
    this.cache.set(key, entry);

    this.hits++;
    return { hit: true, value: entry.data as T };
  }

  public get<T>(key: string): T | null {
    return this.lookup<T>(key).value;
  }

  /**
   * Reads an entry without touching hit/miss counters or LRU ordering. Used by
   * callers that track cache outcomes themselves.
   */
  public peek<T>(key: string): CacheLookup<T> {
    const entry = this.cache.get(key);
    if (!entry) return { hit: false, value: null };
    if (Date.now() > entry.expiresAt) {
      this.deleteEntry(key);
      return { hit: false, value: null };
    }
    return { hit: true, value: entry.data as T };
  }

  public set<T>(key: string, data: T, ttlMs?: number, tags: string[] = []): void {
    if (this.cache.size >= this.maxEntries && !this.cache.has(key)) {
      this.evictOldest();
    }

    const ttl = Math.min(ttlMs ?? this.defaultTtlMs, this.maxTtlMs);
    const expiresAt = Date.now() + ttl;

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
    this.sets++;

    for (const tag of tags) {
      let set = this.tagIndex.get(tag);
      if (!set) {
        set = new Set<string>();
        this.tagIndex.set(tag, set);
      }
      set.add(key);
    }
  }

  /**
   * Single-flight read-through helper: concurrent callers for the same key share
   * one in-flight loader instead of stampeding the database.
   */
  public async getOrLoad<T>(
    key: string,
    loader: () => Promise<T>,
    ttlMs?: number,
    tags: string[] = [],
    trackStats = true
  ): Promise<T> {
    const { hit, value } = trackStats ? this.lookup<T>(key) : this.peek<T>(key);
    if (hit) return value as T;

    const pending = this.inflight.get(key);
    if (pending) return pending as Promise<T>;

    const load = (async (): Promise<T> => {
      const result = await loader();
      this.set(key, result, ttlMs, tags);
      return result;
    })();

    const tracked = load.finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, tracked);

    return tracked;
  }

  public invalidateKey(key: string): boolean {
    this.inflight.delete(key);
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
      this.inflight.delete(key);
      if (this.cache.delete(key)) {
        this.removeKeyFromTags(key);
        count++;
      }
    }

    return count;
  }

  public clear(): void {
    this.cache.clear();
    this.tagIndex.clear();
    this.inflight.clear();
  }

  public purgeExpired(): number {
    const now = Date.now();
    let purged = 0;
    for (const [key, entry] of [...this.cache.entries()]) {
      if (now > entry.expiresAt) {
        if (this.deleteEntry(key)) purged++;
      }
    }
    return purged;
  }

  public getStats(): QueryCacheStats {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      size: this.cache.size,
      maxEntries: this.maxEntries,
      evictions: this.evictions,
      sets: this.sets,
      deletes: this.deletes,
      hitRate: total === 0 ? 0 : Math.round((this.hits / total) * 10000) / 10000,
      inflight: this.inflight.size,
    };
  }

  public resetStats(): void {
    this.hits = 0;
    this.misses = 0;
    this.sets = 0;
    this.deletes = 0;
    this.evictions = 0;
  }

  private deleteEntry(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;

    this.removeKeyFromTags(key);
    const deleted = this.cache.delete(key);
    if (deleted) this.deletes++;
    return deleted;
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
