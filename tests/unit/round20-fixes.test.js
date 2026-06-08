/**
 * Round 20 — voices internalApi, GitHub releases cache + stale fallback
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const proxyAwareFetch = vi.hoisted(() => vi.fn());
const CACHE_KEY = "__9routerGitHubReleasesCache";

vi.mock("open-sse/utils/proxyFetch.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    proxyAwareFetch: (...args) => proxyAwareFetch(...args),
  };
});

const root = dirname(fileURLToPath(import.meta.url));

describe("v1/audio/voices internalApi migration", () => {
  it("uses internalApiGet with path-based provider map (no bare fetch)", () => {
    const src = readFileSync(
      join(root, "../../src/app/api/v1/audio/voices/route.js"),
      "utf8"
    );
    expect(src).toContain("internalApiGet");
    expect(src).toContain('elevenlabs: "/api/media-providers/tts/elevenlabs/voices"');
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toContain("UPDATER_CONFIG");
  });
});

describe("fetchGitHubReleases caching", () => {
  beforeEach(() => {
    vi.resetModules();
    proxyAwareFetch.mockReset();
    delete globalThis[CACHE_KEY];
  });

  afterEach(() => {
    delete globalThis[CACHE_KEY];
  });

  it("returns cached releases without refetching within TTL", async () => {
    proxyAwareFetch.mockResolvedValue({
      ok: true,
      json: async () => [{ tag_name: "v1.0.0", draft: false }],
    });

    const { fetchGitHubReleases } = await import("../../src/lib/githubReleases.js");
    const first = await fetchGitHubReleases();
    const second = await fetchGitHubReleases();

    expect(first.ok).toBe(true);
    expect(second.cached).toBe(true);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
  });

  it("returns stale cache when GitHub fetch fails after a successful refresh", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ tag_name: "v1.0.0", draft: false }],
      })
      .mockResolvedValueOnce({ ok: false, status: 503 });

    const { fetchGitHubReleases } = await import("../../src/lib/githubReleases.js");
    await fetchGitHubReleases({ forceRefresh: true });
    const stale = await fetchGitHubReleases({ forceRefresh: true });

    expect(stale.stale).toBe(true);
    expect(stale.releases).toHaveLength(1);
    expect(stale.error).toContain("503");
  });
});

describe("version routes stale fallback", () => {
  beforeEach(() => {
    vi.resetModules();
    proxyAwareFetch.mockReset();
    delete globalThis[CACHE_KEY];
  });

  afterEach(() => {
    delete globalThis[CACHE_KEY];
  });

  it("version/releases serves stale data with warning instead of 502", async () => {
    globalThis[CACHE_KEY] = {
      ts: 0,
      data: [{ tag_name: "v9.9.9", draft: false, name: "Nine", html_url: "https://example.com", published_at: "2026-01-01" }],
    };

    proxyAwareFetch.mockResolvedValue({ ok: false, status: 502 });

    const { GET } = await import("../../src/app/api/version/releases/route.js");
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.stale).toBe(true);
    expect(body.releases.length).toBeGreaterThan(0);
    expect(body.warning).toContain("502");
  });
});
