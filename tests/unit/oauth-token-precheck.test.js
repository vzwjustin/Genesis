/**
 * OAuth token pre-check and refresh (5-minute expiry window)
 * No mocks: constants, skip-path behavior, source inspection for proxyAwareFetch.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach } from "vitest";

const root = dirname(fileURLToPath(import.meta.url));

describe("OAuth Token Pre-Check (5-minute expiry window)", () => {
  beforeEach(async () => {
    const { __clearRefreshDedupCacheForTests } = await import("../../open-sse/services/tokenRefresh.js");
    __clearRefreshDedupCacheForTests();
  });

  describe("TOKEN_EXPIRY_BUFFER_MS", () => {
    it("should be 5 minutes (300000 ms)", async () => {
      const { TOKEN_EXPIRY_BUFFER_MS } = await import("../../src/sse/services/tokenRefresh.js");
      expect(TOKEN_EXPIRY_BUFFER_MS).toBe(5 * 60 * 1000);
    });
  });

  describe("getRefreshLeadMs", () => {
    it("defaults to TOKEN_EXPIRY_BUFFER_MS for unknown providers", async () => {
      const { getRefreshLeadMs, TOKEN_EXPIRY_BUFFER_MS } = await import("../../open-sse/services/tokenRefresh.js");
      expect(getRefreshLeadMs("gemini-cli")).toBe(TOKEN_EXPIRY_BUFFER_MS);
    });

    it("uses longer lead for codex (5 days)", async () => {
      const { getRefreshLeadMs } = await import("../../open-sse/services/tokenRefresh.js");
      expect(getRefreshLeadMs("codex")).toBe(5 * 24 * 60 * 60 * 1000);
    });
  });

  describe("checkAndRefreshToken — no-network paths", () => {
    it("should NOT refresh token when expiry is more than 5 minutes away", async () => {
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      const { checkAndRefreshToken } = await import("../../src/sse/services/tokenRefresh.js");

      const credentials = {
        accessToken: "current-access-token",
        refreshToken: "current-refresh-token",
        expiresAt,
        connectionId: "test-connection-id",
        providerSpecificData: {},
      };

      const result = await checkAndRefreshToken("gemini-cli", credentials);
      expect(result.accessToken).toBe("current-access-token");
    });

    it("should skip refresh when no expiresAt is set", async () => {
      const { checkAndRefreshToken } = await import("../../src/sse/services/tokenRefresh.js");

      const credentials = {
        accessToken: "api-key-token",
        refreshToken: "some-refresh",
        connectionId: "test-connection-id",
        providerSpecificData: {},
      };

      const result = await checkAndRefreshToken("openai", credentials);
      expect(result.accessToken).toBe("api-key-token");
    });

    it("should skip proactive refresh when expiresAt is set but refreshToken is missing (Cursor import)", async () => {
      const { checkAndRefreshToken } = await import("../../src/sse/services/tokenRefresh.js");
      const expiresAt = new Date(Date.now() + 60_000).toISOString();

      const credentials = {
        accessToken: "cursor-jwt",
        expiresAt,
        connectionId: "cursor-conn",
        providerSpecificData: {},
      };

      const result = await checkAndRefreshToken("cursor", credentials);
      expect(result.accessToken).toBe("cursor-jwt");
      expect(result._tokenRefreshFailed).toBeUndefined();
    });
  });

  describe("token refresh implementation (source)", () => {
    it("open-sse refresh functions use proxyAwareFetch not bare fetch", () => {
      const src = readFileSync(join(root, "../../open-sse/services/tokenRefresh.js"), "utf8");
      expect(src).toContain("proxyAwareFetch");
      expect(src).not.toMatch(/[^a-zA-Z]fetch\s*\(/);
    });

    it("checkAndRefreshToken compares remaining time to getRefreshLeadMs", () => {
      const src = readFileSync(join(root, "../../src/sse/services/tokenRefresh.js"), "utf8");
      expect(src).toContain("_getRefreshLeadMs");
      expect(src).toContain("remaining < refreshLead");
      expect(src).toContain("_tokenRefreshFailed");
      expect(src).toContain("updateProviderConnection");
    });

    it("refresh failure marks connection testStatus error for fallback", () => {
      const src = readFileSync(join(root, "../../src/sse/services/tokenRefresh.js"), "utf8");
      expect(src).toContain('testStatus: "error"');
      expect(src).toContain("Token refresh failed");
    });

    it("GitHub path refreshes copilot token when within buffer", () => {
      const src = readFileSync(join(root, "../../src/sse/services/tokenRefresh.js"), "utf8");
      expect(src).toContain("copilotToken");
      expect(src).toContain("refreshCopilotToken");
    });

    it("usage connection route skips refresh for non-refreshable executors", () => {
      const src = readFileSync(join(root, "../../src/app/api/usage/[connectionId]/route.js"), "utf8");
      expect(src).toContain("supportsTokenRefresh === false");
    });
  });
});
