import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for Provider Credential Selection — Connection Filtering (Task 4.1)
 *
 * Validates:
 * 1. Connections are filtered by provider
 * 2. Connections with rateLimitedUntil in the future are excluded
 * 3. Connections with failed OAuth refresh (testStatus === "error") are excluded
 * 4. The excludeConnectionIds parameter allows excluding already-tried connections during retry
 *
 * Requirements: 3.1
 */

// Mock modules before importing the module under test
vi.mock("@/lib/localDb", () => ({
  getProviderConnections: vi.fn(),
  validateApiKey: vi.fn(),
  updateProviderConnection: vi.fn(),
  getSettings: vi.fn().mockResolvedValue({
    fallbackStrategy: "fill-first",
    providerStrategies: {},
  }),
  getSettingsSafe: vi.fn().mockResolvedValue({
    fallbackStrategy: "fill-first",
    providerStrategies: {},
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

vi.mock("open-sse/config/errorConfig.js", () => ({
  MAX_RATE_LIMIT_COOLDOWN_MS: 300000,
}));

// Suppress log output during tests
vi.mock("../utils/logger.js", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  request: vi.fn(),
}));

// Fix: the logger path in the source is relative — try the actual alias
vi.mock("../../src/sse/utils/logger.js", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  request: vi.fn(),
}));

const { getProviderConnections } = await import("@/lib/localDb");
const { getProviderCredentials } = await import("../../src/sse/services/auth.js");

function makeConnection(overrides = {}) {
  return {
    id: overrides.id || "conn-1",
    provider: overrides.provider || "claude",
    authType: "apikey",
    name: overrides.name || "Test Connection",
    email: null,
    priority: overrides.priority || 1,
    isActive: true,
    apiKey: overrides.apiKey || "sk-test-key",
    accessToken: overrides.accessToken || null,
    refreshToken: null,
    testStatus: overrides.testStatus || "active",
    lastError: overrides.lastError || null,
    rateLimitedUntil: overrides.rateLimitedUntil || null,
    backoffLevel: overrides.backoffLevel || 0,
    providerSpecificData: overrides.providerSpecificData || {},
    displayName: overrides.displayName || overrides.name || "Test Connection",
    consecutiveUseCount: overrides.consecutiveUseCount || 0,
    ...(overrides.modelLocks || {}),
  };
}

describe("Provider Credential Selection — Connection Filtering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Filter by provider", () => {
    it("only returns connections for the requested provider", async () => {
      const claudeConn = makeConnection({ id: "claude-1", provider: "claude" });
      const openaiConn = makeConnection({ id: "openai-1", provider: "openai" });

      // getProviderConnections is called with { provider: "claude", isActive: true }
      // so the DB layer itself filters by provider. We simulate this.
      getProviderConnections.mockResolvedValue([claudeConn]);

      const result = await getProviderCredentials("claude");
      expect(result).not.toBeNull();
      expect(result.connectionId).toBe("claude-1");

      // Verify getProviderConnections was called with the correct provider filter
      expect(getProviderConnections).toHaveBeenCalledWith({ provider: "claude", isActive: true });
    });
  });

  describe("Exclude rateLimitedUntil in future", () => {
    it("excludes connections with rateLimitedUntil in the future", async () => {
      const futureTime = new Date(Date.now() + 60000).toISOString(); // 60s from now
      const rateLimitedConn = makeConnection({
        id: "conn-limited",
        rateLimitedUntil: futureTime,
      });
      const activeConn = makeConnection({
        id: "conn-active",
        priority: 2,
      });

      getProviderConnections.mockResolvedValue([rateLimitedConn, activeConn]);

      const result = await getProviderCredentials("claude");
      expect(result).not.toBeNull();
      expect(result.connectionId).toBe("conn-active");
    });

    it("includes connections with rateLimitedUntil in the past", async () => {
      const pastTime = new Date(Date.now() - 60000).toISOString(); // 60s ago
      const expiredCooldownConn = makeConnection({
        id: "conn-expired-cooldown",
        rateLimitedUntil: pastTime,
      });

      getProviderConnections.mockResolvedValue([expiredCooldownConn]);

      const result = await getProviderCredentials("claude");
      expect(result).not.toBeNull();
      expect(result.connectionId).toBe("conn-expired-cooldown");
    });

    it("includes connections with null rateLimitedUntil", async () => {
      const conn = makeConnection({ id: "conn-no-limit", rateLimitedUntil: null });
      getProviderConnections.mockResolvedValue([conn]);

      const result = await getProviderCredentials("claude");
      expect(result).not.toBeNull();
      expect(result.connectionId).toBe("conn-no-limit");
    });

    it("returns allRateLimited when only rate-limited connections exist with model locks", async () => {
      const futureTime = new Date(Date.now() + 60000).toISOString();
      const lockedConn = makeConnection({
        id: "conn-locked",
        rateLimitedUntil: futureTime,
        modelLocks: { "modelLock_claude-sonnet": futureTime },
      });

      getProviderConnections.mockResolvedValue([lockedConn]);

      const result = await getProviderCredentials("claude", null, "claude-sonnet");
      // When all connections are locked via modelLock, returns allRateLimited
      expect(result).not.toBeNull();
      expect(result.allRateLimited).toBe(true);
    });
  });

  describe("Exclude failed OAuth refresh (invalid credentials)", () => {
    it("excludes connections with testStatus === 'error'", async () => {
      const errorConn = makeConnection({
        id: "conn-error",
        testStatus: "error",
        lastError: "OAuth refresh failed",
        priority: 1,
      });
      const activeConn = makeConnection({
        id: "conn-active",
        testStatus: "active",
        priority: 2,
      });

      getProviderConnections.mockResolvedValue([errorConn, activeConn]);

      const result = await getProviderCredentials("claude");
      expect(result).not.toBeNull();
      expect(result.connectionId).toBe("conn-active");
    });

    it("returns null when all connections have testStatus === 'error'", async () => {
      const errorConn1 = makeConnection({
        id: "conn-error-1",
        testStatus: "error",
        lastError: "OAuth refresh failed",
      });
      const errorConn2 = makeConnection({
        id: "conn-error-2",
        testStatus: "error",
        lastError: "Invalid API key",
      });

      getProviderConnections.mockResolvedValue([errorConn1, errorConn2]);

      const result = await getProviderCredentials("claude");
      // No model locks active, so no allRateLimited; returns null
      expect(result).toBeNull();
    });

    it("includes connections with testStatus === 'active'", async () => {
      const activeConn = makeConnection({
        id: "conn-active",
        testStatus: "active",
      });

      getProviderConnections.mockResolvedValue([activeConn]);

      const result = await getProviderCredentials("claude");
      expect(result).not.toBeNull();
      expect(result.connectionId).toBe("conn-active");
    });

    it("includes connections with testStatus === 'unavailable' (cooldown-based, not credential failure)", async () => {
      // testStatus "unavailable" is set during cooldown (markAccountUnavailable)
      // but not treated as permanent credential failure — model locks handle cooldown
      const unavailableConn = makeConnection({
        id: "conn-unavailable",
        testStatus: "unavailable",
      });

      getProviderConnections.mockResolvedValue([unavailableConn]);

      const result = await getProviderCredentials("claude");
      expect(result).not.toBeNull();
      expect(result.connectionId).toBe("conn-unavailable");
    });
  });

  describe("excludeConnectionIds parameter", () => {
    it("excludes connections by ID using a Set", async () => {
      const conn1 = makeConnection({ id: "conn-1", priority: 1 });
      const conn2 = makeConnection({ id: "conn-2", priority: 2 });
      const conn3 = makeConnection({ id: "conn-3", priority: 3 });

      getProviderConnections.mockResolvedValue([conn1, conn2, conn3]);

      const excludeSet = new Set(["conn-1", "conn-2"]);
      const result = await getProviderCredentials("claude", excludeSet);
      expect(result).not.toBeNull();
      expect(result.connectionId).toBe("conn-3");
    });

    it("excludes connections by ID using a single string", async () => {
      const conn1 = makeConnection({ id: "conn-1", priority: 1 });
      const conn2 = makeConnection({ id: "conn-2", priority: 2 });

      getProviderConnections.mockResolvedValue([conn1, conn2]);

      const result = await getProviderCredentials("claude", "conn-1");
      expect(result).not.toBeNull();
      expect(result.connectionId).toBe("conn-2");
    });

    it("returns null when all connections are excluded", async () => {
      const conn1 = makeConnection({ id: "conn-1" });
      const conn2 = makeConnection({ id: "conn-2" });

      getProviderConnections.mockResolvedValue([conn1, conn2]);

      const excludeSet = new Set(["conn-1", "conn-2"]);
      const result = await getProviderCredentials("claude", excludeSet);
      expect(result).toBeNull();
    });

    it("works with null excludeConnectionIds (no exclusions)", async () => {
      const conn = makeConnection({ id: "conn-1" });
      getProviderConnections.mockResolvedValue([conn]);

      const result = await getProviderCredentials("claude", null);
      expect(result).not.toBeNull();
      expect(result.connectionId).toBe("conn-1");
    });
  });

  describe("Combined filtering", () => {
    it("applies all filters simultaneously", async () => {
      const futureTime = new Date(Date.now() + 60000).toISOString();
      const connections = [
        makeConnection({ id: "conn-excluded", priority: 1 }),
        makeConnection({ id: "conn-rate-limited", priority: 2, rateLimitedUntil: futureTime }),
        makeConnection({ id: "conn-error", priority: 3, testStatus: "error" }),
        makeConnection({
          id: "conn-model-locked", priority: 4,
          modelLocks: { "modelLock_claude-sonnet": futureTime },
        }),
        makeConnection({ id: "conn-good", priority: 5, testStatus: "active" }),
      ];

      getProviderConnections.mockResolvedValue(connections);

      const excludeSet = new Set(["conn-excluded"]);
      const result = await getProviderCredentials("claude", excludeSet, "claude-sonnet");
      expect(result).not.toBeNull();
      expect(result.connectionId).toBe("conn-good");
    });
  });
});

describe("Provider Credential Selection — proactive-refresh fields", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // #3: checkAndRefreshToken's proactive-refresh gate is `if (creds.expiresAt && creds.refreshToken)`.
  // If getProviderCredentials drops expiresAt, proactive refresh never runs for any SSE handler and
  // tokens are only refreshed reactively after an upstream 401 — which causes invalid_grant for
  // rotating refresh tokens (Anthropic). The returned credentials MUST carry expiresAt.
  it("returns expiresAt so the proactive-refresh gate can fire", async () => {
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();
    const conn = { ...makeConnection({ id: "claude-1" }), refreshToken: "rt-test", expiresAt };
    getProviderConnections.mockResolvedValue([conn]);

    const result = await getProviderCredentials("claude");
    expect(result).not.toBeNull();
    expect(result.expiresAt).toBe(expiresAt);
    expect(result.refreshToken).toBe("rt-test");
  });
});
