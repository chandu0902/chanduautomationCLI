'use strict';

/**
 * In-memory Deribit API rate limiter with:
 *  - Token-bucket throttle (configurable requests/sec per API key)
 *  - TTL cache for order-status responses
 *  - In-flight deduplication (concurrent calls for same key share one promise)
 */

// ─── Token-bucket rate limiter ───────────────────────────────────────────────

class TokenBucket {
  constructor(maxTokens = 8, refillRate = 8) {
    this.maxTokens = maxTokens;
    this.tokens = maxTokens;
    this.refillRate = refillRate;       // tokens per second
    this.lastRefill = Date.now();
    this._queue = [];
    this._draining = false;
  }

  _refill() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }

  async acquire() {
    this._refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    return new Promise((resolve) => {
      this._queue.push(resolve);
      this._scheduleDrain();
    });
  }

  _scheduleDrain() {
    if (this._draining) return;
    this._draining = true;
    const tick = () => {
      this._refill();
      while (this._queue.length > 0 && this.tokens >= 1) {
        this.tokens -= 1;
        this._queue.shift()();
      }
      if (this._queue.length > 0) {
        const waitMs = Math.ceil((1 / this.refillRate) * 1000);
        setTimeout(tick, waitMs);
      } else {
        this._draining = false;
      }
    };
    const waitMs = Math.ceil((1 / this.refillRate) * 1000);
    setTimeout(tick, waitMs);
  }
}

// ─── TTL Cache ───────────────────────────────────────────────────────────────

class TTLCache {
  constructor(defaultTtlMs = 2000, maxEntries = 500) {
    this._store = new Map();
    this._defaultTtl = defaultTtlMs;
    this._maxEntries = maxEntries;
  }

  get(key) {
    const entry = this._store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this._store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value, ttlMs) {
    if (this._store.size >= this._maxEntries) {
      const oldest = this._store.keys().next().value;
      this._store.delete(oldest);
    }
    this._store.set(key, {
      value,
      expiresAt: Date.now() + (ttlMs ?? this._defaultTtl),
    });
  }

  delete(key) {
    this._store.delete(key);
  }
}

// ─── In-flight dedup ─────────────────────────────────────────────────────────

class InflightDedup {
  constructor() {
    this._pending = new Map();
  }

  async dedupe(key, fn) {
    if (this._pending.has(key)) {
      return this._pending.get(key);
    }
    const promise = fn().finally(() => this._pending.delete(key));
    this._pending.set(key, promise);
    return promise;
  }
}

// ─── Singleton instances per API key ─────────────────────────────────────────

const _buckets = new Map();

function getBucket(apiKey) {
  if (!_buckets.has(apiKey)) {
    // 8 requests/sec with burst capacity of 10
    _buckets.set(apiKey, new TokenBucket(10, 8));
  }
  return _buckets.get(apiKey);
}

const orderStatusCache = new TTLCache(2000, 1000);
const orderStatusDedup = new InflightDedup();

// Terminal states can be cached much longer — the order won't change again
const TERMINAL_STATES = new Set(['filled', 'cancelled', 'canceled', 'rejected', 'untriggered']);
const TERMINAL_TTL_MS = 30000;
const PENDING_TTL_MS = 1500;

module.exports = {
  TokenBucket,
  TTLCache,
  InflightDedup,
  getBucket,
  orderStatusCache,
  orderStatusDedup,
  TERMINAL_STATES,
  TERMINAL_TTL_MS,
  PENDING_TTL_MS,
};
