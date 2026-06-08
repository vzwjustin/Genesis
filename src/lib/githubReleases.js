import { GITHUB_CONFIG } from "@/shared/constants/config";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";

const GITHUB_HEADERS = {
  Accept: "application/vnd.github+json",
  "User-Agent": "9Router",
};

/**
 * Fetch GitHub releases list via proxyAwareFetch (respects env proxy).
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: true, releases: object[] } | { ok: false, error: string }>}
 */
export async function fetchGitHubReleases({ timeoutMs = 10000 } = {}) {
  try {
    const response = await proxyAwareFetch(GITHUB_CONFIG.releasesApiUrl, {
      headers: GITHUB_HEADERS,
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return { ok: false, error: `GitHub API returned ${response.status}` };
    }
    let releases;
    try {
      releases = await response.json();
    } catch {
      return { ok: false, error: "Invalid JSON from GitHub releases API" };
    }
    if (!Array.isArray(releases)) {
      return { ok: false, error: "Unexpected GitHub releases response shape" };
    }
    return { ok: true, releases };
  } catch (err) {
    return { ok: false, error: err?.message || "Failed to fetch GitHub releases" };
  }
}
