/**
 * Version API — source inspection (no network mocks).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const root = dirname(fileURLToPath(import.meta.url));

describe("version API", () => {
  it("uses fetchGitHubReleases with stale fallback instead of bare fetch", () => {
    const src = readFileSync(join(root, "../../src/app/api/version/route.js"), "utf8");
    expect(src).toContain("fetchGitHubReleases");
    expect(src).toContain("result.stale");
    expect(src).toContain("hasUpdate");
    expect(src).not.toMatch(/\bfetch\s*\(/);
  });

  it("githubReleases targets the fork releases API via proxyAwareFetch", () => {
    const src = readFileSync(join(root, "../../src/lib/githubReleases.js"), "utf8");
    expect(src).toContain("GITHUB_CONFIG.releasesApiUrl");
    expect(src).toContain("proxyAwareFetch");
    expect(src).toContain("User-Agent");
  });
});
