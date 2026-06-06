/**
 * Unit tests for max retry limit enforcement (Task 6.6)
 *
 * Requirement 4.7: THE Proxy SHALL retry at most N times per request, where N equals
 * the number of configured Connections for the provider.
 *
 * Cases validated:
 * 1. With 3 connections configured, retries at most 3 times then returns error
 * 2. With 1 connection configured, retries at most 1 time then returns error
 * 3. Successful response on first try does not exhaust retries
 * 4. Successful response on second try stops retrying
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mock all dependencies before importing module under test ---

const mockGetProviderConnections = vi.fn();

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: (...args) => mockGetProviderConnections(...args),
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
  FREE_PROVIDERS: {},
}));

vi.mock("open-sse/services/accountFallback.js", async (importOriginal) => {
  const actual = await importOriginal();
  return actual;
});

vi.mock("open-sse/config/errorConfig.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    MAX_RATE_LIMIT_COOLDOWN_MS: 300000,
  };
});

vi.mock("../../src/sse/utils/logger.js", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  request: vi.fn(),
  maskKey: vi.fn(() => "sk-***"),
}));

vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  updateProviderCredentials: vi.fn().mockResolvedValue(undefined),
  checkAndRefreshToken: vi.fn((provider, creds) => Promise.resolve(creds)),
}));

vi.mock("open-sse/utils/claudeHeaderCache.js", () => ({
  cacheClaudeHeaders: vi.fn(),
}));

const mockHandleChatCore = vi.fn();
vi.mock("open-sse/handlers/chatCore.js", () => ({
  handleChatCore: (...args) => mockHandleChatCore(...args),
}));

vi.mock("open-sse/utils/error.js", async (importOriginal) => {
  const actual = await importOriginal();
  return actual;
});

vi.mock("open-sse/utils/bypassHandler.js", () => ({
  handleBypassRequest: vi.fn(() => null),
}));

vi.mock("open-sse/translator/formats.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    detectFormatByEndpoint: vi.fn(() => null),
  };
});

vi.mock("open-sse/services/projectId.js", () => ({
  getProjectIdForConnection: vi.fn().mockResolvedValue(null),
}));

vi.mock("open-sse/services/combo.js", () => ({
  handleComboChat: vi.fn(),
}));

vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: vi.fn().mockResolvedValue({ provider: "claude", model: "claude-sonnet-4-20250514" }),
  getComboModels: vi.fn().mockResolvedValue(null),
}));

const { getSettings } = await import("@/lib/localDb");
const { handleChat } = await import("../../src/sse/handlers/chat.js");

function makeConnection(id, priority = 1) {
  return {
    id,
    provider: "claude",
    authType: "apikey",
    name: `Account ${id}`,
    displayName: `Account ${id}`,
    priority,
    isActive: true,
    apiKey: `sk-test-${id}`,
    testStatus: "active",
    rateLimitedUntil: null,
    backoffLevel: 0,
    providerSpecificData: {},
  };
}

function makeRequest(body = { model: "claude/claude-sonnet-4-20250514", messages: [{ role: "user", content: "hi" }] }) {
  return new Request("http://localhost:3456/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Max retries = number of configured connections (Requirement 4.7)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSettings.mockResolvedValue({
      fallbackStrategy: "fill-first",
      providerStrategies: {},
      requireApiKey: false,
    });
  });

  it("retries at most N times when N connections are configured (3 connections)", async () => {
    const connections = [makeConnection("c1", 1), makeConnection("c2", 2), makeConnection("c3", 3)];

    // getProviderConnections is called twice: once to get maxRetries, once inside getProviderCredentials
    mockGetProviderConnections.mockResolvedValue(connections);

    // All attempts fail with shouldFallback=true
    mockHandleChatCore.mockResolvedValue({
      success: false,
      status: 429,
      error: "Rate limited",
      response: new Response("Rate limited", { status: 429 }),
    });

    const response = await handleChat(makeRequest());

    // Should have called handleChatCore exactly 3 times (one per connection)
    expect(mockHandleChatCore).toHaveBeenCalledTimes(3);
    // Final response should be an error (429 since no 5xx occurred, Req 4.5 only forces 503 when 5xx present)
    expect(response.status).toBe(429);
  });

  it("retries at most 1 time when only 1 connection is configured", async () => {
    const connections = [makeConnection("c1", 1)];

    mockGetProviderConnections.mockResolvedValue(connections);

    mockHandleChatCore.mockResolvedValue({
      success: false,
      status: 429,
      error: "Rate limited",
      response: new Response("Rate limited", { status: 429 }),
    });

    const response = await handleChat(makeRequest());

    // Should have called handleChatCore exactly 1 time
    expect(mockHandleChatCore).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(429);
  });

  it("does not exhaust retries when request succeeds on first try", async () => {
    const connections = [makeConnection("c1", 1), makeConnection("c2", 2), makeConnection("c3", 3)];

    mockGetProviderConnections.mockResolvedValue(connections);

    mockHandleChatCore.mockResolvedValue({
      success: true,
      response: new Response("OK", { status: 200 }),
    });

    const response = await handleChat(makeRequest());

    expect(mockHandleChatCore).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
  });

  it("stops retrying after successful response on second try", async () => {
    const connections = [makeConnection("c1", 1), makeConnection("c2", 2), makeConnection("c3", 3)];

    mockGetProviderConnections.mockResolvedValue(connections);

    // First call fails, second succeeds
    mockHandleChatCore
      .mockResolvedValueOnce({
        success: false,
        status: 429,
        error: "Rate limited",
        response: new Response("Rate limited", { status: 429 }),
      })
      .mockResolvedValueOnce({
        success: true,
        response: new Response("OK", { status: 200 }),
      });

    const response = await handleChat(makeRequest());

    expect(mockHandleChatCore).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(200);
  });

  it("returns last error message when max retries exhausted", async () => {
    const connections = [makeConnection("c1", 1), makeConnection("c2", 2)];

    mockGetProviderConnections.mockResolvedValue(connections);

    mockHandleChatCore
      .mockResolvedValueOnce({
        success: false,
        status: 500,
        error: "Internal server error",
        response: new Response("Internal server error", { status: 500 }),
      })
      .mockResolvedValueOnce({
        success: false,
        status: 429,
        error: "Rate limited - please slow down",
        response: new Response("Rate limited", { status: 429 }),
      });

    const response = await handleChat(makeRequest());

    expect(mockHandleChatCore).toHaveBeenCalledTimes(2);
    const body = await response.json();
    expect(body.error.message).toContain("Rate limited - please slow down");
  });

  it("returns HTTP 503 when max retries exhausted and at least one 5xx occurred", async () => {
    const connections = [makeConnection("c1", 1), makeConnection("c2", 2)];

    mockGetProviderConnections.mockResolvedValue(connections);

    // First fails with 500 (5xx), second fails with 429
    mockHandleChatCore
      .mockResolvedValueOnce({
        success: false,
        status: 500,
        error: "Internal server error",
        response: new Response("Internal server error", { status: 500 }),
      })
      .mockResolvedValueOnce({
        success: false,
        status: 429,
        error: "Rate limited",
        response: new Response("Rate limited", { status: 429 }),
      });

    const response = await handleChat(makeRequest());

    // Requirement 4.5: at least one 5xx → HTTP 503
    expect(response.status).toBe(503);
  });
});
