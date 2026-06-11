/**
 * Executor refresh and credential bug fixes
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CodexExecutor } from "../../open-sse/executors/codex.js";
import { GithubExecutor } from "../../open-sse/executors/github.js";
import { BaseExecutor, normalizeExpiryMs } from "../../open-sse/executors/base.js";
import * as proxyFetchModule from "../../open-sse/utils/proxyFetch.js";

describe("CodexExecutor.refreshCredentials", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("refreshes OAuth token via OpenAI token endpoint", async () => {
    vi.spyOn(proxyFetchModule, "proxyAwareFetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
      }),
    });

    const executor = new CodexExecutor();
    const result = await executor.refreshCredentials({ refreshToken: "old-refresh" }, console, null);
    expect(result?.accessToken).toBe("new-access");
    expect(result?.refreshToken).toBe("new-refresh");
  });
});

describe("GithubExecutor.refreshCredentials", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when Copilot token refresh fails after GitHub OAuth refresh", async () => {
    const executor = new GithubExecutor();
    vi.spyOn(executor, "refreshCopilotToken")
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    vi.spyOn(executor, "refreshGitHubToken").mockResolvedValue({
      accessToken: "gh-token",
      refreshToken: "gh-refresh",
      expiresIn: 3600,
    });

    const result = await executor.refreshCredentials({
      accessToken: "old",
      refreshToken: "gh-refresh",
    }, console, null);

    expect(result).toBeNull();
  });
});

describe("BaseExecutor.needsRefresh — expiry normalization", () => {
  const exec = new BaseExecutor("test", {});

  it("treats seconds-unit expiresAt as seconds (not ms)", () => {
    // ~1h in the future expressed in SECONDS — must NOT be read as ms (1970).
    const futureSec = Math.floor(Date.now() / 1000) + 3600;
    expect(exec.needsRefresh({ expiresAt: futureSec })).toBe(false);
    // expired seconds timestamp → needs refresh
    const pastSec = Math.floor(Date.now() / 1000) - 3600;
    expect(exec.needsRefresh({ expiresAt: pastSec })).toBe(true);
  });

  it("handles ms-unit and ISO expiresAt", () => {
    expect(exec.needsRefresh({ expiresAt: Date.now() + 3600_000 })).toBe(false);
    expect(exec.needsRefresh({ expiresAt: new Date(Date.now() + 3600_000).toISOString() })).toBe(false);
  });

  it("refreshes (fail-safe) when expiresAt is unparseable rather than reusing a stale token", () => {
    expect(exec.needsRefresh({ expiresAt: "not-a-date" })).toBe(true);
    expect(exec.needsRefresh({ expiresAt: NaN })).toBe(true);
    expect(exec.needsRefresh({ expiresAt: {} })).toBe(true);
  });

  it("normalizeExpiryMs returns null for garbage and finite ms for valid inputs", () => {
    expect(normalizeExpiryMs("garbage")).toBeNull();
    expect(normalizeExpiryMs(NaN)).toBeNull();
    expect(normalizeExpiryMs(undefined)).toBeNull();
    expect(Number.isFinite(normalizeExpiryMs(Date.now()))).toBe(true);
  });
});
