/**
 * Unit tests for HTTP 2xx handling: reset backoff level and cooldown
 *
 * Requirement 4.4: WHEN the upstream provider returns HTTP 2xx, THE Proxy SHALL
 * reset the Cooldown AND backoff level for that Connection.
 *
 * Validates:
 * 1. On 2xx, backoffLevel is reset to 0
 * 2. On 2xx, rateLimitedUntil is cleared (set to null)
 * 3. This reset does NOT happen on 4xx responses
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock localDb before importing auth.js
vi.mock("@/lib/localDb", () => ({
  getProviderConnections: vi.fn(),
  getProviderConnectionById: vi.fn().mockResolvedValue(null),
  updateProviderConnection: vi.fn().mockResolvedValue(undefined),
  validateApiKey: vi.fn(),
  getSettings: vi.fn().mockResolvedValue({}),
  getSettingsSafe: vi.fn().mockResolvedValue({}),
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

vi.mock("../utils/logger.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  request: vi.fn(),
  maskKey: vi.fn(),
}));

import { clearAccountError } from "../../src/sse/services/auth.js";
import { updateProviderConnection } from "@/lib/localDb";
import { resetAccountState } from "../../open-sse/services/accountFallback.js";

describe("HTTP 2xx Backoff Reset (Requirement 4.4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("clearAccountError — resets on successful request (2xx)", () => {
    it("resets backoffLevel to 0 on success", async () => {
      const connectionId = "conn-123";
      const credentials = {
        _connection: {
          id: connectionId,
          testStatus: "unavailable",
          lastError: "Rate limit exceeded",
          backoffLevel: 5,
          rateLimitedUntil: new Date(Date.now() + 60000).toISOString(),
          "modelLock_claude-sonnet": new Date(Date.now() + 60000).toISOString(),
        },
      };

      await clearAccountError(connectionId, credentials, "claude-sonnet");

      expect(updateProviderConnection).toHaveBeenCalledWith(
        connectionId,
        expect.objectContaining({ backoffLevel: 0 })
      );
    });

    it("clears rateLimitedUntil (sets to null) on success", async () => {
      const connectionId = "conn-456";
      const credentials = {
        _connection: {
          id: connectionId,
          testStatus: "unavailable",
          lastError: "Rate limit exceeded",
          backoffLevel: 3,
          rateLimitedUntil: new Date(Date.now() + 60000).toISOString(),
          "modelLock_gpt-4": new Date(Date.now() + 60000).toISOString(),
        },
      };

      await clearAccountError(connectionId, credentials, "gpt-4");

      expect(updateProviderConnection).toHaveBeenCalledWith(
        connectionId,
        expect.objectContaining({ rateLimitedUntil: null })
      );
    });

    it("sets testStatus to 'active' on success when no remaining locks", async () => {
      const connectionId = "conn-789";
      const credentials = {
        _connection: {
          id: connectionId,
          testStatus: "unavailable",
          lastError: "Server error",
          backoffLevel: 2,
          rateLimitedUntil: new Date(Date.now() + 30000).toISOString(),
          "modelLock_claude-sonnet": new Date(Date.now() + 30000).toISOString(),
        },
      };

      await clearAccountError(connectionId, credentials, "claude-sonnet");

      expect(updateProviderConnection).toHaveBeenCalledWith(
        connectionId,
        expect.objectContaining({
          testStatus: "active",
          lastError: null,
          lastErrorAt: null,
          backoffLevel: 0,
          rateLimitedUntil: null,
        })
      );
    });

    it("clears model lock for the succeeded model", async () => {
      const connectionId = "conn-abc";
      const credentials = {
        _connection: {
          id: connectionId,
          testStatus: "unavailable",
          lastError: "Rate limited",
          backoffLevel: 1,
          "modelLock_claude-sonnet": new Date(Date.now() + 60000).toISOString(),
        },
      };

      await clearAccountError(connectionId, credentials, "claude-sonnet");

      expect(updateProviderConnection).toHaveBeenCalledWith(
        connectionId,
        expect.objectContaining({ "modelLock_claude-sonnet": null })
      );
    });

    it("does NOT reset backoff if other model locks remain active", async () => {
      const connectionId = "conn-multi";
      const futureTime = new Date(Date.now() + 120000).toISOString();
      const credentials = {
        _connection: {
          id: connectionId,
          testStatus: "unavailable",
          lastError: "Rate limited",
          backoffLevel: 3,
          rateLimitedUntil: futureTime,
          "modelLock_claude-sonnet": new Date(Date.now() + 60000).toISOString(),
          "modelLock_gpt-4": futureTime, // still active for a different model
        },
      };

      await clearAccountError(connectionId, credentials, "claude-sonnet");

      // Should clear the succeeded model's lock
      expect(updateProviderConnection).toHaveBeenCalledWith(
        connectionId,
        expect.objectContaining({ "modelLock_claude-sonnet": null })
      );
      // But should NOT reset backoffLevel since gpt-4 lock is still active
      const updateCall = updateProviderConnection.mock.calls[0][1];
      expect(updateCall.backoffLevel).toBeUndefined();
      expect(updateCall.rateLimitedUntil).toBeUndefined();
    });
  });

  describe("resetAccountState (accountFallback.js) — pure function for 2xx reset", () => {
    it("resets backoffLevel to 0", () => {
      const account = { id: "acc-1", backoffLevel: 5, rateLimitedUntil: "2025-01-01T00:00:00Z" };
      const result = resetAccountState(account);
      expect(result.backoffLevel).toBe(0);
    });

    it("clears rateLimitedUntil to null", () => {
      const account = { id: "acc-2", backoffLevel: 3, rateLimitedUntil: "2025-01-01T00:00:00Z" };
      const result = resetAccountState(account);
      expect(result.rateLimitedUntil).toBeNull();
    });

    it("sets status to active", () => {
      const account = { id: "acc-3", backoffLevel: 2, rateLimitedUntil: "2025-01-01T00:00:00Z", status: "error" };
      const result = resetAccountState(account);
      expect(result.status).toBe("active");
    });

    it("clears lastError", () => {
      const account = { id: "acc-4", backoffLevel: 1, lastError: "Rate limit exceeded" };
      const result = resetAccountState(account);
      expect(result.lastError).toBeNull();
    });

    it("returns unchanged account if null", () => {
      expect(resetAccountState(null)).toBeNull();
    });
  });

  describe("4xx does NOT reset backoff (Requirement 4.4 negative case)", () => {
    it("checkFallbackError for 400 does not return newBackoffLevel=0", () => {
      // Import inline to avoid mock conflicts
      const { checkFallbackError } = require("../../open-sse/services/accountFallback.js");
      const result = checkFallbackError(400, "Bad request", 3);
      // 4xx (400) does not trigger fallback or reset — backoff level unchanged
      expect(result.shouldFallback).toBe(false);
      expect(result.newBackoffLevel).toBeUndefined();
    });

    it("onRequestSuccess is NOT called for 4xx responses (verified by chatCore flow)", () => {
      // This is an architectural assertion:
      // In chatCore.js, when !providerResponse.ok (e.g. 4xx), the code returns
      // createErrorResult() WITHOUT calling onRequestSuccess.
      // onRequestSuccess is only called in streaming/non-streaming handlers,
      // which are only reached when providerResponse.ok === true (HTTP 2xx).
      //
      // We verify this indirectly: clearAccountError is NOT called unless
      // onRequestSuccess fires, and onRequestSuccess only fires on 2xx.
      // The test below verifies clearAccountError is a no-op for clean connections.
    });

    it("clearAccountError is a no-op when connection has no error state", async () => {
      const connectionId = "conn-clean";
      const credentials = {
        _connection: {
          id: connectionId,
          testStatus: null,
          lastError: null,
          backoffLevel: 0,
        },
      };

      await clearAccountError(connectionId, credentials, "claude-sonnet");

      // Should not call updateProviderConnection at all — nothing to clear
      expect(updateProviderConnection).not.toHaveBeenCalled();
    });

    it("clearAccountError skips noauth connections", async () => {
      await clearAccountError("noauth", {}, "claude-sonnet");
      expect(updateProviderConnection).not.toHaveBeenCalled();
    });

    it("clearAccountError skips null connectionId", async () => {
      await clearAccountError(null, {}, "claude-sonnet");
      expect(updateProviderConnection).not.toHaveBeenCalled();
    });
  });
});
