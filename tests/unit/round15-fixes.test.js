/**
 * Round 15 — provider validate + test harness proxy migration
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi, beforeEach } from "vitest";

const proxyAwareFetch = vi.hoisted(() => vi.fn());

vi.mock("open-sse/utils/proxyFetch.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    proxyAwareFetch: (...args) => proxyAwareFetch(...args),
  };
});

describe("provider validate route proxy migration", () => {
  beforeEach(() => {
    vi.resetModules();
    proxyAwareFetch.mockReset();
  });

  it("uses proxyAwareFetch with connection proxy during API key validation", async () => {
    proxyAwareFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    });

    vi.mock("@/models", () => ({
      getProviderNodeById: vi.fn().mockResolvedValue({
        baseUrl: "https://example.com/v1",
      }),
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

    const { POST } = await import("../../src/app/api/providers/validate/route.js");
    const response = await POST(new Request("http://localhost/api/providers/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openai-compatible-node",
        apiKey: "sk-test",
        providerSpecificData: {
          connectionProxyEnabled: true,
          connectionProxyUrl: "http://proxy:8080",
        },
      }),
    }));

    expect(response.status).toBe(200);
    expect(proxyAwareFetch).toHaveBeenCalled();
    const passedProxy = proxyAwareFetch.mock.calls[0][2];
    expect(passedProxy.connectionProxyEnabled).toBe(true);
    expect(passedProxy.connectionProxyUrl).toBe("http://proxy:8080");
  });
});

describe("provider test harness bare fetch audit", () => {
  const apiProvidersRoot = join(dirname(fileURLToPath(import.meta.url)), "../../src/app/api/providers");

  it("validate route and testUtils do not use bare fetch()", () => {
    const validateSrc = readFileSync(join(apiProvidersRoot, "validate/route.js"), "utf8");
    const testUtilsSrc = readFileSync(join(apiProvidersRoot, "[id]/test/testUtils.js"), "utf8");
    expect(validateSrc).toContain("validateFetch");
    expect(validateSrc).toContain("proxyAwareFetch");
    expect(validateSrc).not.toMatch(/\bfetch\s*\(/);
    expect(testUtilsSrc).toContain("fetchWithConnectionProxy");
    expect(testUtilsSrc).not.toMatch(/\bfetch\s*\(/);
  });
});
