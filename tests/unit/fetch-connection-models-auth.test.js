import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = {
  proxyAwareFetch: vi.fn(),
  checkAndRefreshToken: vi.fn(),
  refreshTokenByProvider: vi.fn(),
  refreshCopilotToken: vi.fn(),
  updateProviderCredentials: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
};

vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: mocks.proxyAwareFetch,
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
}));

vi.mock("@/sse/services/tokenRefresh", () => ({
  checkAndRefreshToken: mocks.checkAndRefreshToken,
  refreshTokenByProvider: mocks.refreshTokenByProvider,
  refreshCopilotToken: mocks.refreshCopilotToken,
  updateProviderCredentials: mocks.updateProviderCredentials,
}));

vi.mock("open-sse/services/projectId.js", () => ({
  getProjectIdForConnection: vi.fn(),
}));

describe("fetchModelsForConnection auth refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveConnectionProxyConfig.mockResolvedValue({});
    mocks.checkAndRefreshToken.mockImplementation(async (_provider, creds) => ({ ...creds }));
    mocks.updateProviderCredentials.mockResolvedValue(true);
  });

  it("retries codex model fetch after 401 when token refresh succeeds", async () => {
    const connection = {
      id: "conn-codex",
      provider: "codex",
      accessToken: "stale-token",
      refreshToken: "refresh-token",
      providerSpecificData: {},
    };

    mocks.proxyAwareFetch
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => "unauthorized" })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ models: [{ id: "gpt-5", display_name: "GPT-5" }] }),
      });

    mocks.refreshTokenByProvider.mockResolvedValue({
      accessToken: "fresh-token",
      refreshToken: "refresh-token",
      expiresIn: 3600,
    });

    const { fetchModelsForConnection } = await import("../../src/lib/models/fetchConnectionModels.js");
    const result = await fetchModelsForConnection(connection);

    expect(result.error).toBeUndefined();
    expect(result.models?.length).toBeGreaterThan(0);
    expect(mocks.refreshTokenByProvider).toHaveBeenCalledWith("codex", expect.objectContaining({
      refreshToken: "refresh-token",
    }));
    expect(mocks.proxyAwareFetch).toHaveBeenCalledTimes(2);
    expect(connection.accessToken).toBe("fresh-token");
  });

  it("returns a reconnect message when auth refresh fails", async () => {
    const connection = {
      id: "conn-codex-2",
      provider: "codex",
      accessToken: "stale-token",
      refreshToken: "refresh-token",
      providerSpecificData: {},
    };

    mocks.proxyAwareFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "unauthorized",
    });
    mocks.refreshTokenByProvider.mockResolvedValue(null);

    const { fetchModelsForConnection } = await import("../../src/lib/models/fetchConnectionModels.js");
    const result = await fetchModelsForConnection(connection);

    expect(result.status).toBe(401);
    expect(result.error).toContain("Provider session expired");
    expect(result.error).toContain("codex");
  });

  it("prefers apiKey over stale accessToken for apikey authType", async () => {
    const connection = {
      id: "conn-openai",
      provider: "openai",
      authType: "apikey",
      apiKey: "sk-real-openai-key",
      accessToken: "stale-oauth-token",
      providerSpecificData: {},
    };

    mocks.proxyAwareFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "gpt-4o" }] }),
    });

    const { fetchModelsForConnection } = await import("../../src/lib/models/fetchConnectionModels.js");
    await fetchModelsForConnection(connection);

    const [, fetchOpts] = mocks.proxyAwareFetch.mock.calls[0];
    expect(fetchOpts.headers.Authorization).toBe("Bearer sk-real-openai-key");
  });

  it("bootstraps github copilot token before model listing", async () => {
    const connection = {
      id: "conn-github-bootstrap",
      provider: "github",
      authType: "oauth",
      accessToken: "github-access",
      refreshToken: "github-refresh",
      providerSpecificData: {},
    };

    mocks.refreshCopilotToken.mockResolvedValue({
      token: "fresh-copilot",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });

    mocks.proxyAwareFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [{
          id: "gpt-4o",
          name: "GPT-4o",
          capabilities: { type: "chat" },
          policy: { state: "enabled" },
        }],
      }),
    });

    const { fetchModelsForConnection } = await import("../../src/lib/models/fetchConnectionModels.js");
    await fetchModelsForConnection(connection);

    expect(mocks.refreshCopilotToken).toHaveBeenCalledWith("github-access");
    const [, fetchOpts] = mocks.proxyAwareFetch.mock.calls[0];
    expect(fetchOpts.headers.Authorization).toBe("Bearer fresh-copilot");
  });

  it("fetches antigravity models via fetchAvailableModels with project id", async () => {
    const { getProjectIdForConnection } = await import("open-sse/services/projectId.js");
    getProjectIdForConnection.mockResolvedValue("ag-project-123");

    const connection = {
      id: "conn-ag",
      provider: "antigravity",
      authType: "oauth",
      accessToken: "google-access",
      refreshToken: "google-refresh",
      providerSpecificData: {},
    };

    mocks.proxyAwareFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        models: {
          "claude-sonnet-4-6": { displayName: "Claude Sonnet 4.6", isInternal: false },
        },
      }),
    });

    const { fetchModelsForConnection } = await import("../../src/lib/models/fetchConnectionModels.js");
    const result = await fetchModelsForConnection(connection);

    expect(result.models).toHaveLength(1);
    expect(result.models[0].id).toBe("claude-sonnet-4-6");
    const [url, fetchOpts] = mocks.proxyAwareFetch.mock.calls[0];
    expect(url).toContain("fetchAvailableModels");
    expect(fetchOpts.method).toBe("POST");
    expect(JSON.parse(fetchOpts.body)).toEqual({ project: "ag-project-123" });
    expect(fetchOpts.headers["X-Client-Name"]).toBe("antigravity");
    expect(fetchOpts.headers["x-request-source"]).toBe("local");
  });

  it("uses Bearer auth for Claude OAuth model listing (not x-api-key)", async () => {
    const connection = {
      id: "conn-claude",
      provider: "claude",
      accessToken: "oauth-access-token",
      refreshToken: "oauth-refresh",
      providerSpecificData: {},
    };

    mocks.proxyAwareFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "claude-sonnet-4-20250514", display_name: "Claude Sonnet 4" }] }),
    });

    const { fetchModelsForConnection } = await import("../../src/lib/models/fetchConnectionModels.js");
    const result = await fetchModelsForConnection(connection);

    expect(result.models).toHaveLength(1);
    const [, fetchOpts] = mocks.proxyAwareFetch.mock.calls[0];
    expect(fetchOpts.headers.Authorization).toBe("Bearer oauth-access-token");
    expect(fetchOpts.headers["x-api-key"]).toBeUndefined();
    expect(fetchOpts.headers["anthropic-beta"]).toContain("oauth-2025-04-20");
  });

  it("refreshes github copilot token on 401 before retrying", async () => {
    const connection = {
      id: "conn-github",
      provider: "github",
      accessToken: "github-access",
      refreshToken: "github-refresh",
      providerSpecificData: {
        copilotToken: "stale-copilot",
        copilotTokenExpiresAt: 1,
      },
    };

    mocks.proxyAwareFetch
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => "unauthorized" })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: [{
            id: "gpt-4o",
            name: "GPT-4o",
            capabilities: { type: "chat" },
            policy: { state: "enabled" },
          }],
        }),
      });

    mocks.refreshCopilotToken.mockResolvedValue({
      token: "fresh-copilot",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });

    const { fetchModelsForConnection } = await import("../../src/lib/models/fetchConnectionModels.js");
    const result = await fetchModelsForConnection(connection);

    expect(result.models).toHaveLength(1);
    expect(mocks.refreshCopilotToken).toHaveBeenCalledWith("github-access");
    expect(mocks.refreshTokenByProvider).not.toHaveBeenCalled();
    expect(connection.providerSpecificData.copilotToken).toBe("fresh-copilot");
  });

  it("fetches cloudflare-ai models from Workers AI search API", async () => {
    const connection = {
      id: "conn-cf",
      provider: "cloudflare-ai",
      apiKey: "cf-token",
      providerSpecificData: { accountId: "acct-123" },
    };

    mocks.proxyAwareFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: "@cf/meta/llama-3.2-1b-instruct", name: "Llama 3.2 1B Instruct" },
          { id: "@cf/moonshotai/kimi-k2.6", name: "Kimi K2.6" },
        ],
      }),
    });

    const { fetchModelsForConnection } = await import("../../src/lib/models/fetchConnectionModels.js");
    const result = await fetchModelsForConnection(connection);

    expect(result.error).toBeUndefined();
    expect(result.models).toHaveLength(2);
    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      "https://api.cloudflare.com/client/v4/accounts/acct-123/ai/models/search?format=openrouter&per_page=100",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer cf-token",
        }),
      }),
      expect.any(Object),
    );
  });

  it("falls back to static cloudflare-ai catalog when search API fails", async () => {
    const connection = {
      id: "conn-cf-2",
      provider: "cloudflare-ai",
      apiKey: "cf-token",
      providerSpecificData: { accountId: "acct-123" },
    };

    mocks.proxyAwareFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => "server error",
    });

    const { fetchModelsForConnection } = await import("../../src/lib/models/fetchConnectionModels.js");
    const result = await fetchModelsForConnection(connection);

    expect(result.error).toBeUndefined();
    expect(result.models?.length).toBeGreaterThan(0);
    expect(result.models?.[0]?.id).toMatch(/^@cf\//);
    expect(result.warning).toMatch(/Failed to fetch Cloudflare models/);
  });

  it("returns missing account error for cloudflare-ai without accountId", async () => {
    const connection = {
      id: "conn-cf-3",
      provider: "cloudflare-ai",
      apiKey: "cf-token",
      providerSpecificData: {},
    };

    const { fetchModelsForConnection } = await import("../../src/lib/models/fetchConnectionModels.js");
    const result = await fetchModelsForConnection(connection);

    expect(result.error).toBe("Missing Account ID");
    expect(result.status).toBe(400);
    expect(mocks.proxyAwareFetch).not.toHaveBeenCalled();
  });
});
