/**
 * Unit tests for OAuth token pre-check and refresh (5-minute expiry window)
 *
 * Verifies Requirement 3.5:
 * WHEN a pre-check detects that an OAuth access token is within 5 minutes of expiry,
 * THE Proxy SHALL refresh the token before dispatching the request.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock localDb to avoid real DB calls
vi.mock("../../src/lib/localDb.js", () => ({
  updateProviderConnection: vi.fn().mockResolvedValue(true),
  getProviderConnections: vi.fn().mockResolvedValue([]),
}));

// Mock projectId service
vi.mock("open-sse/services/projectId.js", () => ({
  getProjectIdForConnection: vi.fn().mockResolvedValue(null),
  invalidateProjectId: vi.fn(),
  removeConnection: vi.fn(),
}));

const originalFetch = global.fetch;

describe("OAuth Token Pre-Check (5-minute expiry window)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const { __clearRefreshDedupCacheForTests } = await import("../../open-sse/services/tokenRefresh.js");
    __clearRefreshDedupCacheForTests();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe("TOKEN_EXPIRY_BUFFER_MS", () => {
    it("should be 5 minutes (300000 ms)", async () => {
      const { TOKEN_EXPIRY_BUFFER_MS } = await import("../../src/sse/services/tokenRefresh.js");
      expect(TOKEN_EXPIRY_BUFFER_MS).toBe(5 * 60 * 1000);
    });
  });

  describe("checkAndRefreshToken", () => {
    it("should refresh token when expiry is within 5 minutes", async () => {
      // Token expires in 3 minutes (within the 5-minute window)
      const expiresAt = new Date(Date.now() + 3 * 60 * 1000).toISOString();

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          access_token: "new-access-token",
          refresh_token: "new-refresh-token",
          expires_in: 3600,
        }),
      });

      const { checkAndRefreshToken } = await import("../../src/sse/services/tokenRefresh.js");

      const credentials = {
        accessToken: "old-access-token",
        refreshToken: "old-refresh-token",
        expiresAt,
        connectionId: "test-connection-id",
        providerSpecificData: {},
      };

      const result = await checkAndRefreshToken("gemini-cli", credentials);

      // Should have refreshed the token
      expect(result.accessToken).toBe("new-access-token");
      expect(global.fetch).toHaveBeenCalled();
    });

    it("should NOT refresh token when expiry is more than 5 minutes away", async () => {
      // Token expires in 10 minutes (outside the 5-minute window)
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          access_token: "should-not-see-this",
          expires_in: 3600,
        }),
      });

      const { checkAndRefreshToken } = await import("../../src/sse/services/tokenRefresh.js");

      const credentials = {
        accessToken: "current-access-token",
        refreshToken: "current-refresh-token",
        expiresAt,
        connectionId: "test-connection-id",
        providerSpecificData: {},
      };

      const result = await checkAndRefreshToken("gemini-cli", credentials);

      // Should NOT have refreshed the token
      expect(result.accessToken).toBe("current-access-token");
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should refresh token when expiry is exactly at the 5-minute boundary", async () => {
      // Token expires in exactly 5 minutes minus 1ms (just inside the window)
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000 - 1).toISOString();

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          access_token: "refreshed-token",
          refresh_token: "new-refresh",
          expires_in: 3600,
        }),
      });

      const { checkAndRefreshToken } = await import("../../src/sse/services/tokenRefresh.js");

      const credentials = {
        accessToken: "old-token",
        refreshToken: "old-refresh",
        expiresAt,
        connectionId: "test-connection-id",
        providerSpecificData: {},
      };

      const result = await checkAndRefreshToken("gemini-cli", credentials);

      // Should have refreshed (remaining < refreshLead)
      expect(result.accessToken).toBe("refreshed-token");
      expect(global.fetch).toHaveBeenCalled();
    });

    it("should refresh token when it is already expired", async () => {
      // Token expired 1 minute ago
      const expiresAt = new Date(Date.now() - 60 * 1000).toISOString();

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          access_token: "fresh-token",
          refresh_token: "fresh-refresh",
          expires_in: 3600,
        }),
      });

      const { checkAndRefreshToken } = await import("../../src/sse/services/tokenRefresh.js");

      const credentials = {
        accessToken: "expired-token",
        refreshToken: "still-valid-refresh",
        expiresAt,
        connectionId: "test-connection-id",
        providerSpecificData: {},
      };

      const result = await checkAndRefreshToken("gemini-cli", credentials);

      // Should have refreshed
      expect(result.accessToken).toBe("fresh-token");
      expect(global.fetch).toHaveBeenCalled();
    });

    it("should skip refresh when no expiresAt is set", async () => {
      global.fetch = vi.fn();

      const { checkAndRefreshToken } = await import("../../src/sse/services/tokenRefresh.js");

      const credentials = {
        accessToken: "api-key-token",
        refreshToken: "some-refresh",
        // No expiresAt — e.g. API key connections
        connectionId: "test-connection-id",
        providerSpecificData: {},
      };

      const result = await checkAndRefreshToken("openai", credentials);

      // Should not attempt any refresh
      expect(result.accessToken).toBe("api-key-token");
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should use provider-specific refresh lead time (codex: 5 days)", async () => {
      // Token expires in 3 days — within codex's 5-day window
      const expiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          access_token: "codex-refreshed",
          refresh_token: "codex-new-refresh",
          expires_in: 86400,
        }),
      });

      const { checkAndRefreshToken } = await import("../../src/sse/services/tokenRefresh.js");

      const credentials = {
        accessToken: "codex-old-token",
        refreshToken: "codex-refresh-token",
        expiresAt,
        connectionId: "test-connection-id",
        providerSpecificData: {},
      };

      const result = await checkAndRefreshToken("codex", credentials);

      // Should have refreshed because 3 days < 5-day codex lead
      expect(result.accessToken).toBe("codex-refreshed");
      expect(global.fetch).toHaveBeenCalled();
    });

    it("should mark connection unusable and signal fallback when refresh fails", async () => {
      // Token expires in 2 minutes (within window)
      const expiresAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();

      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: () => Promise.resolve("invalid_grant"),
      });

      const { checkAndRefreshToken } = await import("../../src/sse/services/tokenRefresh.js");
      const { updateProviderConnection } = await import("../../src/lib/localDb.js");

      const credentials = {
        accessToken: "old-token",
        refreshToken: "bad-refresh",
        expiresAt,
        connectionId: "test-connection-id",
        providerSpecificData: {},
      };

      const result = await checkAndRefreshToken("gemini-cli", credentials);

      // Should still have the old token since refresh failed
      expect(result.accessToken).toBe("old-token");
      // Should signal token refresh failure for Account_Fallback (Requirement 3.6)
      expect(result._tokenRefreshFailed).toBe(true);
      // Should mark connection as unusable in DB (testStatus=error)
      expect(updateProviderConnection).toHaveBeenCalledWith(
        "test-connection-id",
        expect.objectContaining({
          testStatus: "error",
          lastError: "Token refresh failed",
        })
      );
    });

    it("should mark connection unusable on unrecoverable refresh error (e.g., refresh_token_reused)", async () => {
      // Token expires in 2 minutes (within window)
      const expiresAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();

      // Codex returns unrecoverable error for reused refresh tokens
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: () => Promise.resolve(JSON.stringify({ error: "invalid_grant" })),
      });

      const { checkAndRefreshToken } = await import("../../src/sse/services/tokenRefresh.js");
      const { updateProviderConnection } = await import("../../src/lib/localDb.js");

      const credentials = {
        accessToken: "old-codex-token",
        refreshToken: "reused-refresh-token",
        expiresAt,
        connectionId: "codex-conn-id",
        providerSpecificData: {},
      };

      const result = await checkAndRefreshToken("codex", credentials);

      // Should signal token refresh failure
      expect(result._tokenRefreshFailed).toBe(true);
      // Should mark connection as permanently unusable
      expect(updateProviderConnection).toHaveBeenCalledWith(
        "codex-conn-id",
        expect.objectContaining({
          testStatus: "error",
        })
      );
    });

    it("should persist refreshed credentials to DB", async () => {
      const expiresAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          access_token: "persisted-token",
          refresh_token: "persisted-refresh",
          expires_in: 3600,
        }),
      });

      const { checkAndRefreshToken } = await import("../../src/sse/services/tokenRefresh.js");
      const { updateProviderConnection } = await import("../../src/lib/localDb.js");

      const credentials = {
        accessToken: "old-token",
        refreshToken: "old-refresh",
        expiresAt,
        connectionId: "test-conn-123",
        providerSpecificData: {},
      };

      await checkAndRefreshToken("gemini-cli", credentials);

      // Should have persisted the new credentials
      expect(updateProviderConnection).toHaveBeenCalledWith(
        "test-conn-123",
        expect.objectContaining({
          accessToken: "persisted-token",
        })
      );
    });

    it("should refresh GitHub Copilot token when within expiry buffer", async () => {
      // Main token is fine (expires far in future)
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      // Copilot token expires in 2 minutes (within 5-min buffer)
      const copilotExpiresAt = Math.floor((Date.now() + 2 * 60 * 1000) / 1000);

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          token: "new-copilot-token",
          expires_at: copilotExpiresAt + 3600,
        }),
      });

      const { checkAndRefreshToken } = await import("../../src/sse/services/tokenRefresh.js");

      const credentials = {
        accessToken: "github-access-token",
        refreshToken: "github-refresh",
        expiresAt,
        connectionId: "github-conn-id",
        providerSpecificData: {
          copilotToken: "old-copilot-token",
          copilotTokenExpiresAt: copilotExpiresAt,
        },
      };

      const result = await checkAndRefreshToken("github", credentials);

      // Should have refreshed the Copilot token
      expect(result.providerSpecificData.copilotToken).toBe("new-copilot-token");
      expect(result.copilotToken).toBe("new-copilot-token");
    });
  });
});
