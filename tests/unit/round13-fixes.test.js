/**
 * Round 13 — xAI refresh proxy forwarding
 * No mocks: source inspection.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const root = dirname(fileURLToPath(import.meta.url));

describe("xAI refresh proxy forwarding", () => {
  it("refreshTokenByProvider forwards proxyOptions to XaiService.refreshAccessToken", () => {
    const refreshSrc = readFileSync(join(root, "../../open-sse/services/tokenRefresh.js"), "utf8");
    const xaiBlock = refreshSrc.slice(refreshSrc.indexOf('dedupRefresh("xai"'));
    expect(xaiBlock).toContain("refreshAccessToken(refreshToken, proxyOptions)");
    expect(xaiBlock).toContain("XaiService");
  });

  it("XaiService.refreshAccessToken uses oauthFetch", () => {
    const src = readFileSync(join(root, "../../src/lib/oauth/services/xai.js"), "utf8");
    expect(src).toContain("oauthFetch");
    expect(src).toMatch(/refreshAccessToken\([^)]*proxyOptions/);
  });
});
