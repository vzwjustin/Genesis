/**
 * Max retry limits for non-chat handlers (embeddings, search).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetProviderConnections = vi.fn();
const mockHandleEmbeddingsCore = vi.fn();
const mockHandleSearchCore = vi.fn();

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: (...args) => mockGetProviderConnections(...args),
  validateApiKey: vi.fn(),
  updateProviderConnection: vi.fn(),
  getSettings: vi.fn().mockResolvedValue({
    fallbackStrategy: "fill-first",
    providerStrategies: {},
    requireApiKey: false,
    comboStrategy: "fallback",
  }),
  getCombos: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn().mockResolvedValue({
    connectionProxyEnabled: false,
    connectionProxyUrl: null,
    connectionNoProxy: null,
    proxyPoolId: null,
    vercelRelayUrl: "",
  }),
}));

vi.mock("@/shared/constants/providers.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    resolveProviderId: (p) => p,
    FREE_PROVIDERS: {},
    AI_PROVIDERS: {
      openai: {
        id: "openai",
        searchConfig: { endpoint: "https://example.com/search" },
      },
    },
  };
});

vi.mock("open-sse/services/accountFallback.js", async (importOriginal) => {
  const actual = await importOriginal();
  return actual;
});

vi.mock("../../src/sse/utils/logger.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  request: vi.fn(),
  maskKey: vi.fn(() => "sk-***"),
}));

vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  updateProviderCredentials: vi.fn().mockResolvedValue(undefined),
  checkAndRefreshToken: vi.fn((_provider, creds) => Promise.resolve(creds)),
}));

vi.mock("open-sse/handlers/embeddingsCore.js", () => ({
  handleEmbeddingsCore: (...args) => mockHandleEmbeddingsCore(...args),
}));

vi.mock("open-sse/handlers/search/index.js", () => ({
  handleSearchCore: (...args) => mockHandleSearchCore(...args),
}));

vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: vi.fn().mockResolvedValue({ provider: "openai", model: "text-embedding-3-small" }),
  getComboModels: vi.fn().mockResolvedValue(null),
}));

function makeConn(id) {
  return {
    id,
    provider: "openai",
    authType: "apikey",
    name: `Account ${id}`,
    priority: 1,
    isActive: true,
    apiKey: "sk-test",
    testStatus: "active",
    rateLimitedUntil: null,
    backoffLevel: 0,
    providerSpecificData: {},
  };
}

describe("embeddings handler — max retry limit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHandleEmbeddingsCore.mockResolvedValue({
      success: false,
      status: 429,
      error: "rate limited",
      response: new Response(JSON.stringify({ error: "rate limited" }), { status: 429 }),
    });
  });

  it("attempts at most N times when N connections are configured", async () => {
    mockGetProviderConnections.mockResolvedValue([makeConn("c1"), makeConn("c2")]);

    const { handleEmbeddings } = await import("../../src/sse/handlers/embeddings.js");
    const response = await handleEmbeddings(new Request("http://localhost/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "openai/text-embedding-3-small", input: "hello" }),
    }));

    expect(mockHandleEmbeddingsCore).toHaveBeenCalledTimes(2);
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it("returns 404 immediately when zero connections exist", async () => {
    mockGetProviderConnections.mockResolvedValue([]);

    const { handleEmbeddings } = await import("../../src/sse/handlers/embeddings.js");
    const response = await handleEmbeddings(new Request("http://localhost/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "openai/text-embedding-3-small", input: "hello" }),
    }));

    expect(response.status).toBe(404);
    expect(mockHandleEmbeddingsCore).not.toHaveBeenCalled();
  });
});

describe("search handler — max retry limit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHandleSearchCore.mockResolvedValue({
      success: false,
      status: 503,
      error: "upstream down",
      response: new Response(JSON.stringify({ error: "upstream down" }), { status: 503 }),
    });
  });

  it("attempts at most one time with a single connection", async () => {
    mockGetProviderConnections.mockResolvedValue([makeConn("c1")]);

    const { handleSearch } = await import("../../src/sse/handlers/search.js");
    await handleSearch(new Request("http://localhost/v1/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "openai", query: "test query" }),
    }));

    expect(mockHandleSearchCore).toHaveBeenCalledTimes(1);
  });
});
