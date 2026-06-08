import { createHash } from "crypto";

const store = new Map();
const inflight = new Map();

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
    baseUrl: params.baseUrl || null,
    cx: params.cx || null,
    depth: params.depth || null,
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
      return await inflight.get(key);
    } catch {
      // Fall through to a fresh fetch if the inflight attempt failed.
    }
  }

  const promise = (async () => {
    stats.misses += 1;
    stats.lastMissAt = new Date().toISOString();
    const data = await fetcher();
    try {
      store.set(key, { data: structuredClone(data), expiresAt: now + ttlMs });
      stats.stores += 1;
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
