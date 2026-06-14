import { GITHUB_CONFIG } from "@/shared/constants/config";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";

const GITHUB_HEADERS = {
  Accept: "application/vnd.github+json",
  "User-Agent": "Genesis",
};

const CACHE_TTL_MS = 5 * 60 * 1000;
const G_KEY = "__genesisGitHubReleasesCache";

function gcache() {
  if (!globalThis[G_KEY]) globalThis[G_KEY] = { ts: 0, data: null };
  return globalThis[G_KEY];
}

/**
 * Fetch GitHub releases list via proxyAwareFetch (respects env proxy).
 * @param {{ timeoutMs?: number, forceRefresh?: boolean }} [options]
 * @returns {Promise<{ ok: true, releases: object[], cached?: boolean, stale?: boolean } | { ok: false, error: string, stale?: boolean, releases?: object[] }>}
 */
export async function fetchGitHubReleases({ timeoutMs = 10000, forceRefresh = false } = {}) {
  const cache = gcache();
  if (!forceRefresh && cache.data && Date.now() - cache.ts < CACHE_TTL_MS) {
    return { ok: true, releases: cache.data, cached: true };
  }

  try {
    const response = await proxyAwareFetch(GITHUB_CONFIG.releasesApiUrl, {
      headers: GITHUB_HEADERS,
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      if (cache.data) {
        return { ok: false, error: `GitHub API returned ${response.status}`, stale: true, releases: cache.data };
      }
      return { ok: false, error: `GitHub API returned ${response.status}` };
    }
    let releases;
    try {
      releases = await response.json();
    } catch {
      if (cache.data) {
        return { ok: false, error: "Invalid JSON from GitHub releases API", stale: true, releases: cache.data };
      }
      return { ok: false, error: "Invalid JSON from GitHub releases API" };
    }
    if (!Array.isArray(releases)) {
      if (cache.data) {
        return { ok: false, error: "Unexpected GitHub releases response shape", stale: true, releases: cache.data };
      }
      return { ok: false, error: "Unexpected GitHub releases response shape" };
    }
    cache.ts = Date.now();
    cache.data = releases;
    return { ok: true, releases };
  } catch (err) {
    if (cache.data) {
      return {
        ok: false,
        error: err?.message || "Failed to fetch GitHub releases",
        stale: true,
        releases: cache.data,
      };
    }
    return { ok: false, error: err?.message || "Failed to fetch GitHub releases" };
  }
}
