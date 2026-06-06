import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("getHeadroomProxyStats", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
    delete process.env.HEADROOM_API_KEY;
    delete process.env.HEADROOM_BASE_URL;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns null when proxy health check fails", async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes("/health")) return { ok: false };
      throw new Error("should not fetch stats");
    });

    const { getHeadroomProxyStats } = await import("../../open-sse/rtk/headroom.js");
    await expect(getHeadroomProxyStats("http://localhost:8787")).resolves.toBeNull();
  });

  it("normalizes proxy /stats into dashboard-friendly fields", async () => {
    globalThis.fetch = vi.fn(async (url) => {
      const target = String(url);
      if (target.includes("/health")) return { ok: true };
      if (target.includes("/stats")) {
        return {
          ok: true,
          async json() {
            return {
              summary: {
                compression: { requests_compressed: 2 },
                mcp: { compressions: 5, tokens_removed: 120 },
              },
              tokens: { saved: 450, proxy_compression_saved: 300 },
              requests: { total: 7 },
              cost: { savings_usd: 0.12 },
            };
          },
        };
      }
      throw new Error(`unexpected fetch: ${target}`);
    });

    const { getHeadroomProxyStats } = await import("../../open-sse/rtk/headroom.js");
    const stats = await getHeadroomProxyStats("http://localhost:8787");

    expect(stats).toMatchObject({
      dashboardUrl: "http://localhost:8787/dashboard",
      requestsTotal: 7,
      tokensSaved: 450,
      proxyCompressionSaved: 300,
      mcpCompressions: 5,
      mcpTokensRemoved: 120,
      compressionRequests: 2,
      costSavingsUsd: 0.12,
    });
  });
});
