// ─────────────────────────────────────────────
// Sentinel — Generic in-memory LRU cache with TTL.
// Used by IdentifyClient (tenant + permission caches) and any
// adapter that wants a small per-process cache without bringing
// in a third-party dep.
// ─────────────────────────────────────────────

export class LRUCache {
  /**
   * @param {object} opts
   * @param {number} opts.maxSize
   * @param {number} opts.defaultTtlMs
   */
  constructor(opts) {
    this.maxSize = opts.maxSize;
    this.defaultTtlMs = opts.defaultTtlMs;
    this.map = new Map();
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key, value, ttlMs) {
    this.map.delete(key);
    if (this.map.size >= this.maxSize) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, {
      value,
      expiresAt: Date.now() + (ttlMs ?? this.defaultTtlMs),
    });
  }

  delete(key) {
    return this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }

  get size() {
    return this.map.size;
  }
}
