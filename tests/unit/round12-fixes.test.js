/**
 * Round 12 — proxy migration for token refresh, project ID, image prefetch, headroom
 * No mocks: source inspection.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const root = dirname(fileURLToPath(import.meta.url));

describe("tokenRefresh proxy migration", () => {
  it("refreshCodexToken accepts and forwards proxyOptions to proxyAwareFetch", () => {
    const src = readFileSync(join(root, "../../open-sse/services/tokenRefresh.js"), "utf8");
    const block = src.slice(src.indexOf("export async function refreshCodexToken"));
    expect(block).toContain("proxyAwareFetch");
    expect(block).toMatch(/proxyOptions/);
  });

  it("refreshTokenByProvider derives proxyOptions from credentials when omitted", () => {
    const src = readFileSync(join(root, "../../open-sse/services/tokenRefresh.js"), "utf8");
    expect(src).toContain("buildProxyOptionsFromCredentials");
    expect(src).toContain("refreshTokenByProvider");
  });
});

describe("projectId proxy migration", () => {
  it("getProjectIdForConnection uses proxyAwareFetch", () => {
    const src = readFileSync(join(root, "../../open-sse/services/projectId.js"), "utf8");
    expect(src).toContain("proxyAwareFetch");
    expect(src).not.toMatch(/\bfetch\s*\(/);
  });
});

describe("fetchImageAsBase64 proxy migration", () => {
  it("forwards proxyOptions to proxyAwareFetch", () => {
    const src = readFileSync(join(root, "../../open-sse/translator/helpers/imageHelper.js"), "utf8");
    expect(src).toContain("proxyAwareFetch");
    expect(src).toContain("proxyOptions");
  });
});

describe("headroom proxy migration", () => {
  it("headroom health and stats probes use proxyAwareFetch", () => {
    const src = readFileSync(join(root, "../../open-sse/rtk/headroom.js"), "utf8");
    expect(src).toContain("proxyAwareFetch");
    expect(src).not.toMatch(/\bfetch\s*\(/);
  });
});
