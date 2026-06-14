import { createHash } from "crypto";

const store = new Map();
const inflight = new Map();

// Bound the cache so distinct queries can't grow it without limit (OOM guard).
const MAX_CACHE_ENTRIES = 1000;

function sweepExpired(now) {
  for (const [k, v] of store) {
    if (!v || v.expiresAt <= now) store.delete(k);
  }
}

function enforceCacheBound() {
  // Map preserves insertion order → evict oldest first (FIFO/LRU-ish).
  while (store.size > MAX_CACHE_ENTRIES) {
    const oldestKey = store.keys().next().value;
    if (oldestKey === undefined) break;
    store.delete(oldestKey);
  }
}

const stats = {
  hits: 0,
  misses: 0,
  stores: 0,
  errors: 0,
  lastHitAt: null,
  lastMissAt: null,
};

function fingerprintToken(token) {
  if (!token) return "noauth";
  return createHash("sha256").update(String(token)).digest("hex").slice(0, 16);
}

export function buildSearchCacheKey(providerId, params) {
  const payload = {
    providerId,
    query: params.query,
    searchType: params.searchType,
    maxResults: params.maxResults,
    country: params.country || null,
    language: params.language || null,
    timeRange: params.timeRange || null,
    offset: params.offset || null,
    domainFilter: params.domainFilter || null,
    contentOptions: params.contentOptions || null,
    providerOptions: params.providerOptions || null,
    // Real per-provider routing knobs (engine cx, custom baseUrl, search depth)
    // live under providerSpecificData — keying on the bare params.* fields hashed
    // `undefined` and let different engines/endpoints collide on the same key.
    providerSpecificData: params.providerSpecificData || null,
    baseUrl: params.baseUrl || params.providerSpecificData?.baseUrl || null,
    cx: params.cx || params.providerSpecificData?.cx || null,
    depth: params.depth || params.providerSpecificData?.depth || null,
    tokenFp: fingerprintToken(params.token),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function getSearchCacheStats() {
  return { ...stats, entries: store.size };
}

export async function withSearchCache({ providerId, providerConfig, params, fetcher }) {
  const ttlMs = Number(providerConfig?.cacheTTLMs);
  if (!ttlMs || ttlMs <= 0) {
    stats.misses += 1;
    stats.lastMissAt = new Date().toISOString();
    return fetcher();
  }

  const key = buildSearchCacheKey(providerId, params);
  const now = Date.now();
  const cached = store.get(key);
  if (cached && cached.expiresAt <= now) {
    store.delete(key); // reclaim expired entry instead of read-skipping forever
  }
  if (cached && cached.expiresAt > now) {
    stats.hits += 1;
    stats.lastHitAt = new Date().toISOString();
    const data = structuredClone(cached.data);
    if (data?.metrics) {
      data.metrics.cache_hit = true;
      data.metrics.upstream_latency_ms = 0;
    }
    if (data?.usage) {
      data.usage.queries_used = 0;
      data.usage.search_cost_usd = 0;
    }
    return data;
  }

  if (inflight.has(key)) {
    try {
      // Clone so concurrent waiters don't share one mutable object (the
      // cache-hit path above clones; the inflight path must match).
      return structuredClone(await inflight.get(key));
    } catch {
      // Fall through to a fresh fetch if the inflight attempt failed.
    }
  }

  const promise = (async () => {
    stats.misses += 1;
    stats.lastMissAt = new Date().toISOString();
    const data = await fetcher();
    try {
      // Stamp TTL from fetch-completion, not request-entry, so a slow fetch
      // doesn't shorten the real cached lifetime.
      store.set(key, { data: structuredClone(data), expiresAt: Date.now() + ttlMs });
      stats.stores += 1;
      sweepExpired(Date.now());
      enforceCacheBound();
    } catch {
      stats.errors += 1;
    }
    return data;
  })();

  inflight.set(key, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(key);
  }
}

export function clearSearchCache() {
  store.clear();
  inflight.clear();
}
