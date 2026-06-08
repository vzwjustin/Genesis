/**
 * Round 23 — tunnel health checks and registration use proxyAwareFetch
 * No mocks: source inspection.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const root = dirname(fileURLToPath(import.meta.url));
const tunnelRoot = join(root, "../../src/lib/tunnel");

describe("tunnel health checks proxy migration", () => {
  for (const rel of [
    "cloudflare/healthCheck.js",
    "tailscale/healthCheck.js",
  ]) {
    it(`${rel} probes via proxyAwareFetch`, () => {
      const src = readFileSync(join(tunnelRoot, rel), "utf8");
      expect(src).toContain("proxyAwareFetch");
      expect(src).toContain("/api/health");
      expect(src).not.toMatch(/\bfetch\s*\(/);
    });
  }
});

describe("cloudflare tunnel registration", () => {
  it("registerTunnelUrl uses proxyAwareFetch for worker API", () => {
    const src = readFileSync(join(tunnelRoot, "cloudflare/manager.js"), "utf8");
    expect(src).toContain("proxyAwareFetch");
    expect(src).toContain("/api/tunnel/register");
    expect(src).not.toMatch(/\bfetch\s*\(/);
  });
});
