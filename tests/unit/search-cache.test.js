import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  buildSearchCacheKey,
  withSearchCache,
  getSearchCacheStats,
  clearSearchCache,
} from "../../open-sse/handlers/search/cache.js";

describe("search cache", () => {
  beforeEach(() => {
    clearSearchCache();
  });

  it("returns cached result within TTL without calling fetcher twice", async () => {
    const fetcher = vi.fn().mockResolvedValue({ results: [{ title: "a" }] });
    const params = { query: "hello", searchType: "web", maxResults: 5, token: "abc" };
    const cfg = { cacheTTLMs: 60_000 };

    const first = await withSearchCache({ providerId: "tavily", providerConfig: cfg, params, fetcher });
    const second = await withSearchCache({ providerId: "tavily", providerConfig: cfg, params, fetcher });

    expect(first.results[0].title).toBe("a");
    expect(second.results[0].title).toBe("a");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(getSearchCacheStats().hits).toBe(1);
  });

  it("skips cache when cacheTTLMs is missing or zero", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true });
    const params = { query: "x", searchType: "web", maxResults: 5 };

    await withSearchCache({ providerId: "tavily", providerConfig: {}, params, fetcher });
    await withSearchCache({ providerId: "tavily", providerConfig: { cacheTTLMs: 0 }, params, fetcher });

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("builds different keys for different queries", () => {
    const a = buildSearchCacheKey("exa", { query: "a", searchType: "web", maxResults: 5 });
    const b = buildSearchCacheKey("exa", { query: "b", searchType: "web", maxResults: 5 });
    expect(a).not.toBe(b);
  });
});
