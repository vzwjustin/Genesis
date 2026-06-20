import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getProvider: vi.fn(),
  generateAuthData: vi.fn(),
  exchangeTokens: vi.fn(),
  requestDeviceCode: vi.fn(),
  pollForToken: vi.fn(),
  createProviderConnection: vi.fn(),
  startCodexProxy: vi.fn(),
  stopCodexProxy: vi.fn(),
  registerCodexSession: vi.fn(),
  getCodexSessionStatus: vi.fn(),
  clearCodexSession: vi.fn(),
  startXaiProxy: vi.fn(),
  stopXaiProxy: vi.fn(),
  registerXaiSession: vi.fn(),
  getXaiSessionStatus: vi.fn(),
  clearXaiSession: vi.fn(),
  jsonResponse: vi.fn((body, init) => ({ status: init?.status || 200, body })),
  requireSpawnRouteAuth: vi.fn(async () => ({ ok: true })),
  validateProviderBaseUrlWithDns: vi.fn(async (url) => String(url).replace(/\/$/, "")),
}));

vi.mock("@/lib/oauth/providers", () => ({
  getProvider: mocks.getProvider,
  generateAuthData: mocks.generateAuthData,
  exchangeTokens: mocks.exchangeTokens,
  requestDeviceCode: mocks.requestDeviceCode,
  pollForToken: mocks.pollForToken,
  extractCodexAccountInfo: vi.fn(() => ({})),
}));

vi.mock("@/models", () => ({ createProviderConnection: mocks.createProviderConnection }));

vi.mock("@/lib/oauth/utils/server", () => ({
  startCodexProxy: mocks.startCodexProxy,
  stopCodexProxy: mocks.stopCodexProxy,
  registerCodexSession: mocks.registerCodexSession,
  getCodexSessionStatus: mocks.getCodexSessionStatus,
  clearCodexSession: mocks.clearCodexSession,
  startXaiProxy: mocks.startXaiProxy,
  stopXaiProxy: mocks.stopXaiProxy,
  registerXaiSession: mocks.registerXaiSession,
  getXaiSessionStatus: mocks.getXaiSessionStatus,
  clearXaiSession: mocks.clearXaiSession,
}));

vi.mock("next/server", () => ({
  NextResponse: { json: mocks.jsonResponse },
}));

vi.mock("@/lib/auth/spawnRouteAuth", () => ({
  requireSpawnRouteAuth: mocks.requireSpawnRouteAuth,
}));

vi.mock("open-sse/utils/ssrfGuard.js", () => ({
  validateProviderBaseUrlWithDns: mocks.validateProviderBaseUrlWithDns,
}));

const { GET, POST } = await import("../../src/app/api/oauth/[provider]/[action]/route.js");

function makeGETRequest(provider, action, searchParams = {}) {
  const url = new URL(`http://localhost/api/oauth/${provider}/${action}`);
  for (const [k, v] of Object.entries(searchParams)) url.searchParams.set(k, v);
  return { url: url.toString() };
}

function makePOSTRequest(provider, action, body = {}) {
  return {
    url: `http://localhost/api/oauth/${provider}/${action}`,
    json: async () => body,
  };
}

describe("OAuth CSRF — start-proxy and stop-proxy must reject GET", () => {
  beforeEach(() => vi.clearAllMocks());

  it("GET start-proxy returns 405", async () => {
    const response = await GET(makeGETRequest("codex", "start-proxy", { app_port: "12345" }), {
      params: Promise.resolve({ provider: "codex", action: "start-proxy" }),
    });
    expect(response.status).toBe(405);
    expect(mocks.startCodexProxy).not.toHaveBeenCalled();
  });

  it("GET stop-proxy returns 405", async () => {
    const response = await GET(makeGETRequest("codex", "stop-proxy"), {
      params: Promise.resolve({ provider: "codex", action: "stop-proxy" }),
    });
    expect(response.status).toBe(405);
    expect(mocks.stopCodexProxy).not.toHaveBeenCalled();
  });

  it("GET start-proxy for xai returns 405", async () => {
    const response = await GET(makeGETRequest("xai", "start-proxy", { app_port: "12345" }), {
      params: Promise.resolve({ provider: "xai", action: "start-proxy" }),
    });
    expect(response.status).toBe(405);
    expect(mocks.startXaiProxy).not.toHaveBeenCalled();
  });

  it("GET stop-proxy for xai returns 405", async () => {
    const response = await GET(makeGETRequest("xai", "stop-proxy"), {
      params: Promise.resolve({ provider: "xai", action: "stop-proxy" }),
    });
    expect(response.status).toBe(405);
    expect(mocks.stopXaiProxy).not.toHaveBeenCalled();
  });
});

describe("OAuth CSRF — start-proxy and stop-proxy work via POST", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireSpawnRouteAuth.mockResolvedValue({ ok: true });
    mocks.validateProviderBaseUrlWithDns.mockImplementation(async (url) => String(url).replace(/\/$/, ""));
    mocks.startCodexProxy.mockResolvedValue({ success: true, port: 12345 });
    mocks.stopCodexProxy.mockResolvedValue();
  });

  it("POST start-proxy starts codex proxy", async () => {
    const response = await POST(
      makePOSTRequest("codex", "start-proxy", { appPort: 12345 }),
      { params: Promise.resolve({ provider: "codex", action: "start-proxy" }) }
    );
    expect(response.status).toBe(200);
    expect(mocks.requireSpawnRouteAuth).toHaveBeenCalled();
    expect(mocks.startCodexProxy).toHaveBeenCalledWith(12345);
  });

  it("POST exchange rejects before parsing body when auth fails", async () => {
    mocks.requireSpawnRouteAuth.mockResolvedValueOnce({ ok: false, status: 401, error: "unauthorized" });
    const request = { url: "http://localhost/api/oauth/codex/exchange", json: vi.fn() };

    const response = await POST(request, {
      params: Promise.resolve({ provider: "codex", action: "exchange" }),
    });

    expect(response.status).toBe(401);
    expect(request.json).not.toHaveBeenCalled();
    expect(mocks.exchangeTokens).not.toHaveBeenCalled();
    expect(mocks.createProviderConnection).not.toHaveBeenCalled();
  });

  it("validates GitLab baseUrl before token exchange", async () => {
    mocks.exchangeTokens.mockResolvedValue({ accessToken: "tok" });
    mocks.createProviderConnection.mockResolvedValue({ id: "c1", provider: "gitlab" });
    const response = await POST(
      makePOSTRequest("gitlab", "exchange", {
        code: "abc",
        redirectUri: "http://localhost/callback",
        codeVerifier: "verifier",
        meta: { baseUrl: "https://gitlab.example.com/", clientId: "cid" },
      }),
      { params: Promise.resolve({ provider: "gitlab", action: "exchange" }) }
    );

    expect(response.status).toBe(200);
    expect(mocks.validateProviderBaseUrlWithDns).toHaveBeenCalledWith("https://gitlab.example.com/");
    expect(mocks.exchangeTokens.mock.calls[0][5].baseUrl).toBe("https://gitlab.example.com");
  });

  it("POST stop-proxy stops codex proxy", async () => {
    const response = await POST(
      makePOSTRequest("codex", "stop-proxy"),
      { params: Promise.resolve({ provider: "codex", action: "stop-proxy" }) }
    );
    expect(response.status).toBe(200);
    expect(mocks.stopCodexProxy).toHaveBeenCalled();
  });

  it("POST stop-proxy stops xai proxy", async () => {
    mocks.stopXaiProxy.mockResolvedValue();
    const response = await POST(
      makePOSTRequest("xai", "stop-proxy"),
      { params: Promise.resolve({ provider: "xai", action: "stop-proxy" }) }
    );
    expect(response.status).toBe(200);
    expect(mocks.stopXaiProxy).toHaveBeenCalled();
  });

  it("POST start-proxy rejects unknown provider", async () => {
    const response = await POST(
      makePOSTRequest("github", "start-proxy", { appPort: 12345 }),
      { params: Promise.resolve({ provider: "github", action: "start-proxy" }) }
    );
    expect(response.status).toBe(400);
  });

  it("POST stop-proxy rejects unknown provider", async () => {
    const response = await POST(
      makePOSTRequest("github", "stop-proxy"),
      { params: Promise.resolve({ provider: "github", action: "stop-proxy" }) }
    );
    expect(response.status).toBe(400);
  });
});
