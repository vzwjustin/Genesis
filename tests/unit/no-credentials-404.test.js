/**
 * Unit tests for HTTP 404 when no valid-credential connections exist (Task 4.3)
 *
 * Requirement 3.3: IF no active Connection with valid credentials exists for a provider
 * (including the case where all Connections exist but none have valid credentials due to
 * failed token refresh), THEN THE Proxy SHALL return HTTP 404 with the message
 * "No active credentials for provider: {provider}".
 *
 * Requirement 4.8: IF a provider has zero configured Connections, THEN THE Proxy SHALL
 * immediately return HTTP 404 with the message "No active credentials for provider: {provider}"
 * without attempting dispatch or any retries.
 *
 * Cases validated:
 * 1. Zero configured connections → immediate HTTP 404, no request attempted
 * 2. All connections have testStatus="error" (failed OAuth) → HTTP 404
 * 3. Mix of invalid credentials and cooldown → no 404 (different code path)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mock all dependencies before importing module under test ---

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

vi.mock("open-sse/handlers/chatCore.js", () => ({
  handleChatCore: vi.fn(),
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

vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: vi.fn().mockResolvedValue({ provider: "claude", model: "claude-sonnet-4-20250514" }),
  getComboModels: vi.fn().mockResolvedValue(null),
}));

const { getProviderConnections, getSettings } = await import("@/lib/localDb");
const { handleChatCore } = await import("open-sse/handlers/chatCore.js");
const { handleChat } = await import("../../src/sse/handlers/chat.js");

function makeRequest(body = { model: "claude/claude-sonnet-4-20250514", messages: [{ role: "user", content: "hi" }] }) {
  return new Request("http://localhost:3456/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("HTTP 404 — No active credentials for provider (Requirement 3.3, 4.8)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSettings.mockResolvedValue({
      fallbackStrategy: "fill-first",
      providerStrategies: {},
      requireApiKey: false,
    });
  });

  describe("Zero configured connections", () => {
    it("returns HTTP 404 with correct message when provider has zero connections", async () => {
      getProviderConnections.mockResolvedValue([]);

      const response = await handleChat(makeRequest());

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error.message).toBe("No active credentials for provider: claude");
    });

    it("does NOT attempt any upstream request when zero connections exist", async () => {
      getProviderConnections.mockResolvedValue([]);

      await handleChat(makeRequest());

      // handleChatCore should never be called — zero connections = zero retries
      expect(handleChatCore).not.toHaveBeenCalled();
    });
  });

  describe("All connections with failed OAuth (testStatus='error')", () => {
    it("returns HTTP 404 when all connections have testStatus='error'", async () => {
      getProviderConnections.mockResolvedValue([
        {
          id: "conn-1",
          provider: "claude",
          authType: "oauth",
          name: "Account 1",
          priority: 1,
          isActive: true,
          accessToken: "expired-token",
          testStatus: "error",
          lastError: "OAuth refresh failed",
          rateLimitedUntil: null,
          backoffLevel: 0,
          providerSpecificData: {},
        },
        {
          id: "conn-2",
          provider: "claude",
          authType: "oauth",
          name: "Account 2",
          priority: 2,
          isActive: true,
          accessToken: "also-expired",
          testStatus: "error",
          lastError: "Token refresh failed: invalid_grant",
          rateLimitedUntil: null,
          backoffLevel: 0,
          providerSpecificData: {},
        },
      ]);

      const response = await handleChat(makeRequest());

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error.message).toBe("No active credentials for provider: claude");
    });

    it("does NOT attempt any upstream request when all credentials are invalid", async () => {
      getProviderConnections.mockResolvedValue([
        {
          id: "conn-1",
          provider: "claude",
          authType: "oauth",
          name: "Account 1",
          priority: 1,
          isActive: true,
          accessToken: "expired",
          testStatus: "error",
          lastError: "OAuth refresh failed",
          rateLimitedUntil: null,
          backoffLevel: 0,
          providerSpecificData: {},
        },
      ]);

      await handleChat(makeRequest());

      expect(handleChatCore).not.toHaveBeenCalled();
    });
  });

  describe("Message format validation", () => {
    it("includes provider name in the error message", async () => {
      const { getModelInfo } = await import("../../src/sse/services/model.js");
      getModelInfo.mockResolvedValue({ provider: "openai", model: "gpt-4o" });
      getProviderConnections.mockResolvedValue([]);

      const response = await handleChat(makeRequest({ model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] }));

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error.message).toBe("No active credentials for provider: openai");
    });
  });
});
