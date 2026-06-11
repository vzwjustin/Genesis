import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for Priority-Based Sticky Round-Robin Credential Selection (Task 4.2)
 *
 * Validates:
 * - Sort by priority (lower = higher priority)
 * - Apply sticky limit for consecutive requests on same connection
 * - Rotation advances through connections in priority order
 * - Per-provider strategy override respected
 *
 * Requirements: 3.2
 */

// Track update calls to observe consecutiveUseCount/lastUsedAt changes
const updateCalls = [];

const mockGetSettings = vi.hoisted(() => vi.fn());

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: vi.fn(),
  validateApiKey: vi.fn(),
  updateProviderConnection: vi.fn(async (id, data) => {
    updateCalls.push({ id, data });
    return { id, ...data };
  }),
  getSettings: mockGetSettings,
  getSettingsSafe: mockGetSettings,
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

vi.mock("open-sse/services/accountFallback.js", () => ({
  formatRetryAfter: () => "soon",
  checkFallbackError: () => ({ shouldFallback: false, cooldownMs: 0 }),
  isModelLockActive: () => false,
  buildModelLockUpdate: () => ({}),
  getEarliestModelLockUntil: () => null,
}));

vi.mock("open-sse/config/errorConfig.js", () => ({
  MAX_RATE_LIMIT_COOLDOWN_MS: 300000,
}));

vi.mock("../../src/sse/utils/logger.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  request: vi.fn(),
}));

const { getProviderConnections, updateProviderConnection } = await import("@/lib/localDb");
const getSettings = mockGetSettings;
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
    accessToken: null,
    refreshToken: null,
    testStatus: overrides.testStatus || "active",
    lastError: null,
    rateLimitedUntil: null,
    backoffLevel: 0,
    providerSpecificData: overrides.providerSpecificData || {},
    displayName: overrides.displayName || overrides.name || "Test",
    consecutiveUseCount: overrides.consecutiveUseCount || 0,
    lastUsedAt: overrides.lastUsedAt || null,
  };
}

describe("Priority-Based Sticky Round-Robin Credential Selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateCalls.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Round-robin with sticky limit = 1 (rotate every request)", () => {
    it("selects the first connection in priority order when none have been used", async () => {
      const connections = [
        makeConnection({ id: "high", name: "high-priority", priority: 1 }),
        makeConnection({ id: "med", name: "med-priority", priority: 2 }),
        makeConnection({ id: "low", name: "low-priority", priority: 3 }),
      ];

      getProviderConnections.mockResolvedValue(connections);
      getSettings.mockResolvedValue({
        fallbackStrategy: "round-robin",
        stickyRoundRobinLimit: 1,
        providerStrategies: {},
      });

      const result = await getProviderCredentials("claude");
      expect(result.connectionId).toBe("high");
    });

    it("rotates to the next connection in priority order after sticky limit is reached", async () => {
      // Simulate: "high" was just used once with sticky limit 1, so it should rotate
      const connections = [
        makeConnection({ id: "high", name: "high-priority", priority: 1, lastUsedAt: "2024-01-01T00:00:01Z", consecutiveUseCount: 1 }),
        makeConnection({ id: "med", name: "med-priority", priority: 2, lastUsedAt: null }),
        makeConnection({ id: "low", name: "low-priority", priority: 3, lastUsedAt: null }),
      ];

      getProviderConnections.mockResolvedValue(connections);
      getSettings.mockResolvedValue({
        fallbackStrategy: "round-robin",
        stickyRoundRobinLimit: 1,
        providerStrategies: {},
      });

      const result = await getProviderCredentials("claude");
      // "high" has consecutiveUseCount=1 which equals stickyLimit=1
      // → rotate to next in priority: "med" (index 1 in priority-sorted list)
      expect(result.connectionId).toBe("med");
    });

    it("wraps around to the first connection after reaching the end of the priority list", async () => {
      // "low" (last in priority order) was just used
      const connections = [
        makeConnection({ id: "high", name: "high-priority", priority: 1, lastUsedAt: "2024-01-01T00:00:01Z" }),
        makeConnection({ id: "med", name: "med-priority", priority: 2, lastUsedAt: "2024-01-01T00:00:02Z" }),
        makeConnection({ id: "low", name: "low-priority", priority: 3, lastUsedAt: "2024-01-01T00:00:03Z", consecutiveUseCount: 1 }),
      ];

      getProviderConnections.mockResolvedValue(connections);
      getSettings.mockResolvedValue({
        fallbackStrategy: "round-robin",
        stickyRoundRobinLimit: 1,
        providerStrategies: {},
      });

      const result = await getProviderCredentials("claude");
      // "low" is current (most recently used) and count=1 >= limit=1
      // "low" is at index 2 in priority order → next = (2+1) % 3 = 0 → "high"
      expect(result.connectionId).toBe("high");
    });
  });

  describe("Round-robin with sticky limit > 1 (stick for N requests)", () => {
    it("sticks to the current connection when consecutiveUseCount < stickyLimit", async () => {
      // "high" has been used once, sticky limit is 3 → should stick
      const connections = [
        makeConnection({ id: "high", name: "high-priority", priority: 1, lastUsedAt: "2024-01-01T00:00:01Z", consecutiveUseCount: 1 }),
        makeConnection({ id: "med", name: "med-priority", priority: 2 }),
        makeConnection({ id: "low", name: "low-priority", priority: 3 }),
      ];

      getProviderConnections.mockResolvedValue(connections);
      getSettings.mockResolvedValue({
        fallbackStrategy: "round-robin",
        stickyRoundRobinLimit: 3,
        providerStrategies: {},
      });

      const result = await getProviderCredentials("claude");
      // Count is 1 which is < 3 (sticky limit) → stay with "high"
      expect(result.connectionId).toBe("high");

      // Verify the count was incremented
      expect(updateCalls[0].id).toBe("high");
      expect(updateCalls[0].data.consecutiveUseCount).toBe(2);
    });

    it("rotates when consecutiveUseCount reaches the sticky limit", async () => {
      // "high" has been used 3 times, sticky limit is 3 → should rotate
      const connections = [
        makeConnection({ id: "high", name: "high-priority", priority: 1, lastUsedAt: "2024-01-01T00:00:01Z", consecutiveUseCount: 3 }),
        makeConnection({ id: "med", name: "med-priority", priority: 2 }),
        makeConnection({ id: "low", name: "low-priority", priority: 3 }),
      ];

      getProviderConnections.mockResolvedValue(connections);
      getSettings.mockResolvedValue({
        fallbackStrategy: "round-robin",
        stickyRoundRobinLimit: 3,
        providerStrategies: {},
      });

      const result = await getProviderCredentials("claude");
      // Count is 3, limit is 3 → rotate to next in priority: "med"
      expect(result.connectionId).toBe("med");

      // Verify the new connection gets count reset to 1
      expect(updateCalls[0].id).toBe("med");
      expect(updateCalls[0].data.consecutiveUseCount).toBe(1);
    });
  });

  describe("Priority ordering in round-robin", () => {
    it("advances in priority order regardless of creation order", async () => {
      // Even though "low" has lowest priority=3, if "med" (priority=2) was just exhausted,
      // the next in line is "low" (priority=3)
      const connections = [
        makeConnection({ id: "high", name: "high-priority", priority: 1, lastUsedAt: "2024-01-01T00:00:01Z" }),
        makeConnection({ id: "med", name: "med-priority", priority: 2, lastUsedAt: "2024-01-01T00:00:02Z", consecutiveUseCount: 2 }),
        makeConnection({ id: "low", name: "low-priority", priority: 3, lastUsedAt: null }),
      ];

      getProviderConnections.mockResolvedValue(connections);
      getSettings.mockResolvedValue({
        fallbackStrategy: "round-robin",
        stickyRoundRobinLimit: 2,
        providerStrategies: {},
      });

      const result = await getProviderCredentials("claude");
      // "med" is current (most recent), count=2 >= limit=2 → rotate
      // "med" is at index 1 in priority → next = (1+1) % 3 = 2 → "low"
      expect(result.connectionId).toBe("low");
    });
  });

  describe("Fill-first strategy (default)", () => {
    it("always selects the highest priority connection", async () => {
      const connections = [
        makeConnection({ id: "high", name: "high-priority", priority: 1 }),
        makeConnection({ id: "med", name: "med-priority", priority: 2 }),
        makeConnection({ id: "low", name: "low-priority", priority: 3 }),
      ];

      getProviderConnections.mockResolvedValue(connections);
      getSettings.mockResolvedValue({
        fallbackStrategy: "fill-first",
        providerStrategies: {},
      });

      const result = await getProviderCredentials("claude");
      expect(result.connectionId).toBe("high");
    });
  });

  describe("Per-provider strategy override", () => {
    it("uses per-provider round-robin even when global is fill-first", async () => {
      const connections = [
        makeConnection({ id: "high", name: "high-priority", priority: 1, lastUsedAt: "2024-01-01T00:00:01Z", consecutiveUseCount: 2 }),
        makeConnection({ id: "med", name: "med-priority", priority: 2 }),
      ];

      getProviderConnections.mockResolvedValue(connections);
      getSettings.mockResolvedValue({
        fallbackStrategy: "fill-first", // global is fill-first
        providerStrategies: {
          claude: {
            fallbackStrategy: "round-robin",
            stickyRoundRobinLimit: 2,
          },
        },
      });

      const result = await getProviderCredentials("claude");
      // Per-provider override: round-robin with sticky=2
      // "high" is current, count=2 >= limit=2 → rotate to "med"
      expect(result.connectionId).toBe("med");
    });

    it("uses per-provider sticky limit when specified", async () => {
      const connections = [
        makeConnection({ id: "high", name: "high-priority", priority: 1, lastUsedAt: "2024-01-01T00:00:01Z", consecutiveUseCount: 1 }),
        makeConnection({ id: "med", name: "med-priority", priority: 2 }),
      ];

      getProviderConnections.mockResolvedValue(connections);
      getSettings.mockResolvedValue({
        fallbackStrategy: "round-robin",
        stickyRoundRobinLimit: 3, // global limit is 3
        providerStrategies: {
          claude: {
            fallbackStrategy: "round-robin",
            stickyRoundRobinLimit: 1, // but provider limit is 1
          },
        },
      });

      const result = await getProviderCredentials("claude");
      // Per-provider sticky limit=1, count=1 >= 1 → rotate to "med"
      expect(result.connectionId).toBe("med");
    });
  });

  describe("Edge cases", () => {
    it("handles single connection with round-robin (always sticks)", async () => {
      const connections = [
        makeConnection({ id: "only", name: "only-conn", priority: 1, lastUsedAt: "2024-01-01T00:00:01Z", consecutiveUseCount: 5 }),
      ];

      getProviderConnections.mockResolvedValue(connections);
      getSettings.mockResolvedValue({
        fallbackStrategy: "round-robin",
        stickyRoundRobinLimit: 3,
        providerStrategies: {},
      });

      const result = await getProviderCredentials("claude");
      // Only one connection, even if count exceeds limit, rotation wraps to same
      // count=5 >= limit=3 → rotate, next = (0+1) % 1 = 0 → "only" (wraps back)
      expect(result.connectionId).toBe("only");
    });

    it("handles all connections with no lastUsedAt (first call)", async () => {
      const connections = [
        makeConnection({ id: "high", name: "high-priority", priority: 1, lastUsedAt: null }),
        makeConnection({ id: "med", name: "med-priority", priority: 2, lastUsedAt: null }),
      ];

      getProviderConnections.mockResolvedValue(connections);
      getSettings.mockResolvedValue({
        fallbackStrategy: "round-robin",
        stickyRoundRobinLimit: 2,
        providerStrategies: {},
      });

      const result = await getProviderCredentials("claude");
      // No connection has lastUsedAt → enters the "rotate" branch
      // Current is the "most recent" but none have been used → byRecency[0] has no lastUsedAt
      // → enters rotate branch → picks first in priority order
      expect(result.connectionId).toBe("high");
    });
  });
});
