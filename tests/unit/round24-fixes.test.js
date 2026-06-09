/**
 * Round 24 — round8/9 + oauth test harness no-mocks cleanup
 * No mocks: confirms earlier round tests no longer depend on vi.mock fetch stubs.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const root = dirname(fileURLToPath(import.meta.url));

const NO_MOCK_ROUND_FILES = [
  "round8-fixes.test.js",
  "round9-fixes.test.js",
  "oauth-fetch-proxy.test.js",
  "xai-oauth-service.test.js",
];

describe("round8–9 and oauth tests avoid fetch mocks", () => {
  for (const file of NO_MOCK_ROUND_FILES) {
    it(`${file} does not vi.mock proxyFetch or stub global fetch`, () => {
      const src = readFileSync(join(root, file), "utf8");
      expect(src).not.toContain("vi.mock(");
      expect(src).not.toContain("vi.hoisted");
      expect(src).not.toContain("stubGlobal");
      expect(src).not.toMatch(/global\.fetch\s*=/);
    });
  }
});

describe("server-side upstream fetch audit (src/app/api routes)", () => {
  it("proxy-pool deploy routes use proxyAwareFetch on the Node server path", () => {
    for (const route of [
      "proxy-pools/vercel-deploy/route.js",
      "proxy-pools/deno-deploy/route.js",
      "proxy-pools/cloudflare-deploy/route.js",
    ]) {
      const src = readFileSync(join(root, "../../src/app/api", route), "utf8");
      expect(src).toContain("proxyAwareFetch");
      const outsideTemplates = src.replace(/`[\s\S]*?`/g, "");
      expect(outsideTemplates).not.toMatch(/\bfetch\s*\(/);
    }
  });
});
