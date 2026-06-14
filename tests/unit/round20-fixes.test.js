/**
 * Round 20 — voices internalApi, GitHub releases cache + stale fallback
 * No mocks: source inspection + pure function probes where applicable.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

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
  it("githubReleases.js implements TTL cache and stale fallback", () => {
    const src = readFileSync(join(root, "../../src/lib/githubReleases.js"), "utf8");
    expect(src).toContain("CACHE_TTL_MS");
    expect(src).toContain("__genesisGitHubReleasesCache");
    expect(src).toContain("cached: true");
    expect(src).toContain("stale: true");
    expect(src).toContain("forceRefresh");
    expect(src).toContain("proxyAwareFetch");
  });
});

describe("version routes stale fallback", () => {
  it("version route uses fetchGitHubReleases and surfaces stale warnings", () => {
    const version = readFileSync(join(root, "../../src/app/api/version/route.js"), "utf8");
    expect(version).toContain("fetchGitHubReleases");
    expect(version).toContain("result.stale");
    expect(version).not.toMatch(/\bfetch\s*\(/);
  });

  it("version/releases serves stale data with warning instead of hard 502", () => {
    const releases = readFileSync(join(root, "../../src/app/api/version/releases/route.js"), "utf8");
    expect(releases).toContain("fetchGitHubReleases");
    expect(releases).toContain("!result.stale");
    expect(releases).toContain("stale: true");
    expect(releases).not.toMatch(/\bfetch\s*\(/);
  });
});
