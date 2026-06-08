/**
 * Round 14 — provider models route proxy migration
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const proxyAwareFetch = vi.hoisted(() => vi.fn());

vi.mock("open-sse/utils/proxyFetch.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    proxyAwareFetch: (...args) => proxyAwareFetch(...args),
  };
});

vi.mock("@/models", () => ({
  getProviderConnectionById: vi.fn(),
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn().mockResolvedValue({
    connectionProxyEnabled: true,
    connectionProxyUrl: "http://proxy:8080",
    connectionNoProxy: "",
    vercelRelayUrl: "",
    strictProxy: false,
  }),
}));

describe("GET /api/providers/[id]/models proxy migration", () => {
  beforeEach(() => {
    vi.resetModules();
    proxyAwareFetch.mockReset();
  });

  it("uses proxyAwareFetch for OpenAI-compatible provider model listing", async () => {
    proxyAwareFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "gpt-4o" }] }),
    });

    const { getProviderConnectionById } = await import("@/models");
    getProviderConnectionById.mockResolvedValue({
      id: "conn-1",
      provider: "openai-compatible-local",
      apiKey: "sk-test",
      providerSpecificData: {
        baseUrl: "https://example.com/v1",
        connectionProxyEnabled: true,
        connectionProxyUrl: "http://proxy:8080",
      },
    });

    const { GET } = await import("../../src/app/api/providers/[id]/models/route.js");
    const response = await GET(new Request("http://localhost/api/providers/conn-1/models"), {
      params: Promise.resolve({ id: "conn-1" }),
    });

    expect(response.status).toBe(200);
    expect(proxyAwareFetch).toHaveBeenCalled();
    const passedProxy = proxyAwareFetch.mock.calls[0][2];
    expect(passedProxy.connectionProxyEnabled).toBe(true);
    expect(passedProxy.connectionProxyUrl).toBe("http://proxy:8080");
  });
});

describe("usage fetcher re-export", () => {
  it("re-exports getUsageForProvider from open-sse", async () => {
    const legacy = await import("../../src/lib/usage/fetcher.js");
    const canonical = await import("../../open-sse/services/usage.js");
    expect(legacy.getUsageForProvider).toBe(canonical.getUsageForProvider);
  });
});
