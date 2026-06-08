/**
 * Executor refresh and credential bug fixes
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CodexExecutor } from "../../open-sse/executors/codex.js";
import { GithubExecutor } from "../../open-sse/executors/github.js";
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
