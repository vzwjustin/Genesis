/**
 * Account fallback exhaustion (Tasks 6.5–6.7)
 * Requirements 4.5, 4.7, 4.8
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: vi.fn(),
  validateApiKey: vi.fn(),
  updateProviderConnection: vi.fn(),
  getSettings: vi.fn().mockResolvedValue({
    fallbackStrategy: "fill-first",
    providerStrategies: {},
    requireApiKey: false,
  }),
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

vi.mock("@/shared/constants/providers.js", () => ({
  resolveProviderId: (p) => p,
  FREE_PROVIDERS: {
    opencode: { id: "opencode", noAuth: true },
  },
}));

vi.mock("../../src/sse/utils/logger.js", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  request: vi.fn(),
  maskKey: vi.fn(() => "sk-***"),
}));

vi.mock("../../src/sse/services/auth.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    authenticateRequest: vi.fn().mockResolvedValue({
      ok: true,
      apiKey: null,
      settings: { requireApiKey: false },
    }),
    getProviderCredentials: vi.fn(),
    markAccountUnavailable: vi.fn().mockImplementation(async (_connectionId, statusCode) => ({
      shouldFallback: statusCode === 429 || statusCode >= 500,
    })),
    clearAccountError: vi.fn(),
  };
});

vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  updateProviderCredentials: vi.fn().mockResolvedValue(undefined),
  checkAndRefreshToken: vi.fn((_provider, creds) => Promise.resolve(creds)),
}));

vi.mock("open-sse/utils/claudeHeaderCache.js", () => ({
  cacheClaudeHeaders: vi.fn(),
}));

vi.mock("open-sse/utils/bypassHandler.js", () => ({
  handleBypassRequest: vi.fn(() => null),
}));

vi.mock("open-sse/translator/formats.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, detectFormatByEndpoint: vi.fn(() => null) };
});

vi.mock("open-sse/services/projectId.js", () => ({
  getProjectIdForConnection: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: vi.fn().mockResolvedValue({ provider: "claude", model: "claude-sonnet-4-20250514" }),
  getComboModels: vi.fn().mockResolvedValue(null),
}));

const mockHandleChatCore = vi.fn();
vi.mock("open-sse/handlers/chatCore.js", () => ({
  handleChatCore: (...args) => mockHandleChatCore(...args),
}));

const { getProviderConnections } = await import("@/lib/localDb");
const { getProviderCredentials } = await import("../../src/sse/services/auth.js");
const { handleChat } = await import("../../src/sse/handlers/chat.js");

function makeRequest() {
  return new Request("http://localhost:3456/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude/claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hi" }],
    }),
  });
}

function connection(id, name) {
  return {
    id,
    provider: "claude",
    authType: "api_key",
    name,
    connectionName: name,
    priority: 1,
    isActive: true,
    apiKey: `key-${id}`,
    testStatus: "active",
    rateLimitedUntil: null,
    backoffLevel: 0,
    providerSpecificData: {},
  };
}

describe("account fallback exhaustion (Tasks 6.5–6.7)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns HTTP 404 immediately when zero connections configured (Req 4.8)", async () => {
    getProviderConnections.mockResolvedValue([]);

    const response = await handleChat(makeRequest());

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.message).toBe("No active credentials for provider: claude");
    expect(mockHandleChatCore).not.toHaveBeenCalled();
  });

  it("dispatches noAuth provider even with zero stored connections", async () => {
    const { getModelInfo } = await import("../../src/sse/services/model.js");
    getModelInfo.mockResolvedValueOnce({ provider: "opencode", model: "gpt-4" });
    getProviderConnections.mockResolvedValue([]);
    getProviderCredentials.mockResolvedValueOnce({
      id: "noauth",
      connectionName: "Public",
      accessToken: "public",
      providerSpecificData: {},
    });
    mockHandleChatCore.mockResolvedValueOnce({
      success: true,
      response: new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    });

    const request = new Request("http://localhost:3456/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "opencode/gpt-4",
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    const response = await handleChat(request);

    expect(response.status).toBe(200);
    expect(mockHandleChatCore).toHaveBeenCalledTimes(1);
  });

  it("retries at most once per configured connection (Req 4.7)", async () => {
    getProviderConnections.mockResolvedValue([
      connection("c1", "Account 1"),
      connection("c2", "Account 2"),
    ]);
    getProviderCredentials
      .mockResolvedValueOnce({ ...connection("c1", "Account 1"), connectionId: "c1" })
      .mockResolvedValueOnce({ ...connection("c2", "Account 2"), connectionId: "c2" });

    mockHandleChatCore
      .mockResolvedValueOnce({ success: false, status: 503, error: "upstream down" })
      .mockResolvedValueOnce({ success: false, status: 503, error: "still down" });

    await handleChat(makeRequest());

    expect(mockHandleChatCore).toHaveBeenCalledTimes(2);
  });

  it("returns HTTP 503 with last error when all connections hit 5xx (Req 4.5)", async () => {
    getProviderConnections.mockResolvedValue([
      connection("c1", "Account 1"),
      connection("c2", "Account 2"),
    ]);
    getProviderCredentials
      .mockResolvedValueOnce({ ...connection("c1", "Account 1"), connectionId: "c1" })
      .mockResolvedValueOnce({ ...connection("c2", "Account 2"), connectionId: "c2" });

    mockHandleChatCore
      .mockResolvedValueOnce({ success: false, status: 502, error: "first 502" })
      .mockResolvedValueOnce({ success: false, status: 503, error: "final 503" });

    const response = await handleChat(makeRequest());

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.message).toContain("final 503");
  });

  it("forces HTTP 503 when at least one connection returned 5xx even if last was 429 (Req 4.5)", async () => {
    getProviderConnections.mockResolvedValue([
      connection("c1", "Account 1"),
      connection("c2", "Account 2"),
    ]);
    getProviderCredentials
      .mockResolvedValueOnce({ ...connection("c1", "Account 1"), connectionId: "c1" })
      .mockResolvedValueOnce({ ...connection("c2", "Account 2"), connectionId: "c2" });

    mockHandleChatCore
      .mockResolvedValueOnce({ success: false, status: 500, error: "internal error" })
      .mockResolvedValueOnce({ success: false, status: 429, error: "rate limited" });

    const response = await handleChat(makeRequest());

    // Requirement 4.5: at least one 5xx → return 503 regardless of last error status
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.message).toContain("rate limited");
  });
});
