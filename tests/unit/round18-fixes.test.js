/**
 * Round 18 — GitHub releases, MCP SSRF, proxy deploy, combo errors across handlers
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { getBrokenComboErrorFromData } from "../../open-sse/services/combo.js";

describe("cowork MCP SSRF guard", () => {
  it("route uses assertSafeFetchUrl and proxyAwareFetch", () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../src/app/api/cli-tools/cowork-mcp-tools/route.js"),
      "utf8"
    );
    expect(src).toContain("assertSafeFetchUrl");
    expect(src).toContain("proxyAwareFetch");
    expect(src).not.toMatch(/\bfetch\s*\(/);
  });
});

describe("GitHub releases helper", () => {
  it("fetchGitHubReleases uses proxyAwareFetch and fails closed on invalid JSON shape", () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../src/lib/githubReleases.js"),
      "utf8"
    );
    expect(src).toContain("proxyAwareFetch");
    expect(src).toContain("!Array.isArray(releases)");
    expect(src).toContain("Unexpected GitHub releases response shape");
  });
});

describe("proxy deploy routes proxy migration", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "../../src/app/api/proxy-pools");

  it("vercel, deno, and cloudflare deploy routes use proxyAwareFetch for admin APIs", () => {
    for (const file of ["vercel-deploy/route.js", "deno-deploy/route.js", "cloudflare-deploy/route.js"]) {
      const src = readFileSync(join(root, file), "utf8");
      expect(src).toContain("proxyAwareFetch");
      // Embedded relay worker code still contains fetch — exclude string templates
      const withoutTemplates = src.replace(/`[\s\S]*?`/g, "");
      expect(withoutTemplates).not.toMatch(/\bfetch\s*\(/);
    }
  });
});

describe("getBrokenComboErrorFromData", () => {
  const combos = [
    { name: "good", models: ["openai/gpt-4o", "anthropic/claude-sonnet"] },
    { name: "single", models: ["openai/gpt-4o"] },
    { name: "empty-combo", models: ["", "  "] },
  ];

  it("returns error for registered combo with no valid targets", () => {
    expect(getBrokenComboErrorFromData("empty-combo", combos)).toBe(
      'Combo "empty-combo" has no valid model targets configured.'
    );
  });

  it("returns error for single-model combo", () => {
    expect(getBrokenComboErrorFromData("single", combos)).toBe(
      'Combo "single" must include at least 2 models for failover.'
    );
  });

  it("returns null for valid combo or unknown name", () => {
    expect(getBrokenComboErrorFromData("good", combos)).toBeNull();
    expect(getBrokenComboErrorFromData("missing", combos)).toBeNull();
    expect(getBrokenComboErrorFromData("openai/gpt-4o", combos)).toBeNull();
  });
});

describe("broken combo checks in media handlers", () => {
  it("embeddings, search, fetch handlers import broken combo helpers", () => {
    const handlersRoot = join(dirname(fileURLToPath(import.meta.url)), "../../src/sse/handlers");
    expect(readFileSync(join(handlersRoot, "embeddings.js"), "utf8")).toContain("getBrokenComboError");
    expect(readFileSync(join(handlersRoot, "search.js"), "utf8")).toContain("getBrokenComboErrorFromData");
    expect(readFileSync(join(handlersRoot, "fetch.js"), "utf8")).toContain("getBrokenComboErrorFromData");
    expect(readFileSync(join(handlersRoot, "stt.js"), "utf8")).toContain("getBrokenComboError");
    expect(readFileSync(join(handlersRoot, "tts.js"), "utf8")).toContain("getBrokenComboError");
    expect(readFileSync(join(handlersRoot, "imageGeneration.js"), "utf8")).toContain("getBrokenComboError");
  });
});
