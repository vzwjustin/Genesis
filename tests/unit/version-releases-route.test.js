/**
 * Version releases API — source inspection (no network mocks).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const root = dirname(fileURLToPath(import.meta.url));

describe("version releases API", () => {
  it("annotates releases for upgrade/downgrade and handles stale GitHub failures", () => {
    const src = readFileSync(join(root, "../../src/app/api/version/releases/route.js"), "utf8");
    expect(src).toContain("fetchGitHubReleases");
    expect(src).toContain("compareVersions");
    expect(src).toContain("directionFor");
    expect(src).toContain("installCommand");
    expect(src).toContain("!result.stale");
    expect(src).toContain("stale: true");
    expect(src).not.toMatch(/\bfetch\s*\(/);
  });
});
