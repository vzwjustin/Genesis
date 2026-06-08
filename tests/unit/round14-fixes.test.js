/**
 * Round 14 — provider models route proxy migration
 * No mocks: source inspection + re-export check.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const root = dirname(fileURLToPath(import.meta.url));

describe("GET /api/providers/[id]/models proxy migration", () => {
  it("uses proxyAwareFetch with connection proxy options", () => {
    const src = readFileSync(
      join(root, "../../src/app/api/providers/[id]/models/route.js"),
      "utf8"
    );
    expect(src).toContain("proxyAwareFetch");
    expect(src).toContain("buildProxyOptionsFromConnection");
    expect(src).toContain("resolveConnectionProxyConfig");
    expect(src).not.toMatch(/\bfetch\s*\(/);
  });
});

describe("usage fetcher re-export", () => {
  it("re-exports getUsageForProvider from open-sse", async () => {
    const legacy = await import("../../src/lib/usage/fetcher.js");
    const canonical = await import("../../open-sse/services/usage.js");
    expect(legacy.getUsageForProvider).toBe(canonical.getUsageForProvider);
  });
});
