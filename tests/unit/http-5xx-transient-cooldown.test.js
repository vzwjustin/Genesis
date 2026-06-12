/**
 * Unit tests for HTTP 5xx handling: transient 30s cooldown + retry next connection.
 *
 * Requirement 4.2: WHEN the upstream provider returns HTTP 5xx,
 * THE Proxy SHALL place the current Connection into Cooldown with a
 * transient Cooldown duration of 30s.
 *
 * Verifies:
 * 1. Status codes 500, 502, 503, 504 all trigger a 30s cooldown
 * 2. The connection is marked unavailable for 30 seconds (model lock set)
 * 3. The retry loop picks up the next connection (shouldFallback = true)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  checkFallbackError,
  isAccountUnavailable,
  getUnavailableUntil,
} from "../../open-sse/services/accountFallback.js";
import { TRANSIENT_COOLDOWN_MS } from "../../open-sse/config/errorConfig.js";

// Mock modules for markAccountUnavailable integration tests
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

vi.mock("../../src/sse/utils/logger.js", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  request: vi.fn(),
}));

const { getProviderConnections, updateProviderConnection } = await import("@/lib/localDb");
const { markAccountUnavailable } = await import("../../src/sse/services/auth.js");

describe("HTTP 5xx Transient Cooldown (Requirement 4.2)", () => {
  describe("TRANSIENT_COOLDOWN_MS constant", () => {
    it("is exactly 30 seconds (30000ms)", () => {
      expect(TRANSIENT_COOLDOWN_MS).toBe(30_000);
    });
  });

  describe("checkFallbackError triggers 30s cooldown for all 5xx codes", () => {
    const serverErrorCodes = [500, 502, 503, 504];

    for (const status of serverErrorCodes) {
      it(`HTTP ${status} returns shouldFallback=true with 30s cooldown`, () => {
        const result = checkFallbackError(status, "Server error", 0);

        expect(result.shouldFallback).toBe(true);
        expect(result.cooldownMs).toBe(30_000);
      });

      it(`HTTP ${status} with empty error text still triggers 30s cooldown`, () => {
        const result = checkFallbackError(status, "", 0);

        expect(result.shouldFallback).toBe(true);
        expect(result.cooldownMs).toBe(30_000);
      });

      it(`HTTP ${status} does not use exponential backoff (no newBackoffLevel)`, () => {
        const result = checkFallbackError(status, "Internal server error", 3);

        // 5xx uses fixed cooldown, not exponential backoff
        expect(result.shouldFallback).toBe(true);
        expect(result.cooldownMs).toBe(30_000);
        expect(result.newBackoffLevel).toBeUndefined();
      });
    }

    it("HTTP 501 (Not Implemented) also triggers 30s cooldown via >= 500 catch-all", () => {
      const result = checkFallbackError(501, "Not implemented", 0);

      expect(result.shouldFallback).toBe(true);
      expect(result.cooldownMs).toBe(30_000);
    });

    it("HTTP 599 triggers 30s cooldown via >= 500 catch-all", () => {
      const result = checkFallbackError(599, "Unknown server error", 0);

      expect(result.shouldFallback).toBe(true);
      expect(result.cooldownMs).toBe(30_000);
    });
  });

  describe("5xx text-based rule override: 'overloaded' triggers backoff instead of fixed cooldown", () => {
    // Text rules are checked first; "overloaded" matches backoff rule
    it("HTTP 503 with 'overloaded' in error text uses exponential backoff, not fixed 30s", () => {
      const result = checkFallbackError(503, "The server is overloaded right now", 0);

      expect(result.shouldFallback).toBe(true);
      // Backoff at level 1 = base (2000ms), not TRANSIENT_COOLDOWN_MS
      expect(result.newBackoffLevel).toBe(1);
      expect(result.cooldownMs).not.toBe(30_000);
    });

    it("HTTP 500 with 'rate limit' in error text uses exponential backoff", () => {
      const result = checkFallbackError(500, "Rate limit exceeded", 0);

      expect(result.shouldFallback).toBe(true);
      expect(result.newBackoffLevel).toBe(1);
    });
  });

  describe("Connection unavailability duration", () => {
    it("getUnavailableUntil sets expiry ~30s in the future for 5xx cooldown", () => {
      const before = Date.now();
      const until = getUnavailableUntil(TRANSIENT_COOLDOWN_MS);
      const after = Date.now();

      const expiryMs = new Date(until).getTime();
      // Should be approximately 30s from now
      expect(expiryMs).toBeGreaterThanOrEqual(before + 30_000);
      expect(expiryMs).toBeLessThanOrEqual(after + 30_000);
    });

    it("isAccountUnavailable returns true within the 30s window", () => {
      const until = new Date(Date.now() + 30_000).toISOString();
      expect(isAccountUnavailable(until)).toBe(true);
    });

    it("isAccountUnavailable returns false after the 30s window expires", () => {
      const until = new Date(Date.now() - 1000).toISOString(); // 1s in the past
      expect(isAccountUnavailable(until)).toBe(false);
    });
  });

  describe("proxy-internal 502 does not trigger account rotation", () => {
    it("HTTP 502 with proxyInternal flag returns shouldFallback=false", () => {
      const result = checkFallbackError(502, "Invalid SSE response", 0, { proxyInternal: true });
      expect(result.shouldFallback).toBe(false);
      expect(result.cooldownMs).toBe(0);
    });
  });

  describe("Retry picks up next connection (shouldFallback=true)", () => {
    it("shouldFallback=true signals the retry loop to try the next connection", () => {
      // For all 5xx errors, shouldFallback must be true so the retry loop
      // adds the connection ID to excludeConnectionIds and fetches next
      for (const status of [500, 502, 503, 504]) {
        const { shouldFallback } = checkFallbackError(status, "Error", 0);
        expect(shouldFallback).toBe(true);
      }
    });

    it("4xx errors (non-rate-limit) do NOT trigger fallback", () => {
      // Client errors like 400 should not cause account fallback
      const result = checkFallbackError(400, "Bad request", 0);
      expect(result.shouldFallback).toBe(false);
    });

    it("2xx does NOT trigger fallback", () => {
      const result = checkFallbackError(200, "", 0);
      expect(result.shouldFallback).toBe(false);
    });
  });
});

describe("markAccountUnavailable integration for 5xx", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const serverErrorCodes = [500, 502, 503, 504];

  for (const status of serverErrorCodes) {
    it(`HTTP ${status} marks connection with 30s model lock via markAccountUnavailable`, async () => {
      const mockConn = {
        id: "conn-123",
        name: "Test Connection",
        backoffLevel: 0,
      };
      getProviderConnections.mockResolvedValue([mockConn]);

      const result = await markAccountUnavailable("conn-123", status, "Server error", "claude", "claude-sonnet");

      expect(result.shouldFallback).toBe(true);
      expect(result.cooldownMs).toBe(30_000);

      // Verify updateProviderConnection was called with a model lock ~30s in future
      expect(updateProviderConnection).toHaveBeenCalledWith(
        "conn-123",
        expect.objectContaining({
          testStatus: "unavailable",
          lastError: "Server error",
          errorCode: status,
          backoffLevel: 0,
        })
      );

      // Verify the model lock key was set
      const updateCall = updateProviderConnection.mock.calls[0][1];
      const lockKey = "modelLock_claude-sonnet";
      expect(updateCall[lockKey]).toBeDefined();

      // Verify the lock expires approximately 30s from now
      const lockExpiry = new Date(updateCall[lockKey]).getTime();
      const now = Date.now();
      expect(lockExpiry).toBeGreaterThan(now + 29_000);
      expect(lockExpiry).toBeLessThan(now + 31_000);
    });
  }

  it("skips markAccountUnavailable for noauth connections", async () => {
    const result = await markAccountUnavailable("noauth", 500, "Server error", "openai");

    expect(result.shouldFallback).toBe(false);
    expect(result.cooldownMs).toBe(0);
    expect(updateProviderConnection).not.toHaveBeenCalled();
  });

  it("skips markAccountUnavailable for null connectionId", async () => {
    const result = await markAccountUnavailable(null, 502, "Bad gateway", "claude");

    expect(result.shouldFallback).toBe(false);
    expect(result.cooldownMs).toBe(0);
    expect(updateProviderConnection).not.toHaveBeenCalled();
  });
});
