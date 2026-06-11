import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeTestApiKey, useTestApiKeySecret } from "../helpers/apiKeyTestUtils.js";

const mocks = vi.hoisted(() => ({
  nextResponse: Symbol("next"),
  jsonResponse: vi.fn((body, init) => ({
    status: init?.status || 200,
    body,
  })),
  getSettings: vi.fn(),
  validateApiKey: vi.fn(),
  getConsistentMachineId: vi.fn(),
  verifyDashboardAuthToken: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    next: vi.fn(() => mocks.nextResponse),
    json: mocks.jsonResponse,
    redirect: vi.fn((url) => ({ status: 307, url })),
  },
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  validateApiKey: mocks.validateApiKey,
}));

vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: mocks.getConsistentMachineId,
}));

vi.mock("@/lib/auth/dashboardSession", () => ({
  verifyDashboardAuthToken: mocks.verifyDashboardAuthToken,
}));

const VALID_TEST_KEY = makeTestApiKey();
const { proxy, __test__ } = await import("../../src/dashboardGuard.js");

function request(pathname, headers = {}, socketIp = null) {
  const normalizedHeaders = new Headers(headers);
  return {
    nextUrl: { pathname },
    headers: normalizedHeaders,
    cookies: { get: vi.fn(() => undefined) },
    url: `http://localhost${pathname}`,
    socket: socketIp ? { remoteAddress: socketIp } : undefined,
    ip: socketIp || undefined,
  };
}

describe("dashboard guard public LLM API access", () => {
  beforeEach(() => {
    useTestApiKeySecret();
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    mocks.validateApiKey.mockResolvedValue(false);
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
  });

  it("allows loopback public LLM API without API key when requireApiKey is unset (default off)", async () => {
    const response = await proxy(request("/v1/chat/completions", { host: "localhost:20128" }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("rejects loopback public LLM API without API key when requireApiKey=true", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: true, requireApiKey: true });

    const response = await proxy(request("/v1/chat/completions", { host: "localhost:20128" }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("Missing API key");
  });

  it("rejects public LLM API when remote client spoofs loopback host", async () => {
    const response = await proxy(request("/api/v1/chat/completions", {
      host: "localhost:20128",
      "x-forwarded-for": "203.0.113.9",
    }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required for remote API access");
  });

  it("rejects remote rewritten public LLM API without API key", async () => {
    const response = await proxy(request("/api/v1/chat/completions", { host: "router.example.com" }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required for remote API access");
  });

  it("rejects loopback rewritten public LLM API without API key when requireApiKey=true", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: true, requireApiKey: true });

    const response = await proxy(request("/api/v1/chat/completions", { host: "localhost:20128" }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("Missing API key");
  });

  it("rejects codex rewrite endpoint without API key", async () => {
    const response = await proxy(request("/codex/responses", { host: "router.example.com" }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required for remote API access");
  });

  it("rejects remote beta public LLM API without API key", async () => {
    const response = await proxy(request("/v1beta/models", { host: "router.example.com" }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required for remote API access");
  });

  it("rejects remote rewritten beta public LLM API without API key", async () => {
    const response = await proxy(request("/api/v1beta/models", { host: "router.example.com" }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required for remote API access");
  });

  it("allows remote public LLM API with valid raw Authorization gateway key", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/v1/models", {
      host: "router.example.com",
      authorization: VALID_TEST_KEY,
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith(VALID_TEST_KEY);
  });

  it("allows remote public LLM API with valid bearer API key", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/api/v1/chat/completions", {
      host: "router.example.com",
      authorization: `Bearer ${VALID_TEST_KEY}`,
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith(VALID_TEST_KEY);
  });

  it("allows remote public LLM API with valid x-api-key", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/v1/web/fetch", {
      host: "router.example.com",
      "x-api-key": VALID_TEST_KEY,
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith(VALID_TEST_KEY);
  });

  it("allows remote rewritten beta public LLM API with valid API key", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/api/v1beta/models", {
      host: "router.example.com",
      "x-api-key": VALID_TEST_KEY,
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith(VALID_TEST_KEY);
  });

  it("rejects remote public LLM API without credentials when requireApiKey=false", async () => {
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });

    const response = await proxy(request("/v1/models", { host: "router.example.com" }));

    expect(response.status).toBe(401);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("allows loopback public LLM API without credentials when requireApiKey=false", async () => {
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });

    const response = await proxy(request("/v1/models", {
      host: "localhost:20128",
      origin: "http://localhost:20128",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("allows loopback public LLM API when settings are unavailable (default requireApiKey off)", async () => {
    mocks.getSettings.mockRejectedValue(new Error("db unavailable"));

    const response = await proxy(request("/v1/models", { host: "localhost:20128" }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("rejects remote public LLM API when settings are unavailable", async () => {
    mocks.getSettings.mockRejectedValue(new Error("db unavailable"));

    const response = await proxy(request("/v1/models", { host: "router.example.com" }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required for remote API access");
  });

  it("allows loopback stale gateway bypass when settings are unavailable", async () => {
    mocks.getSettings.mockRejectedValue(new Error("db unavailable"));

    const response = await proxy(request("/v1/models", {
      host: "localhost:20128",
      "x-api-key": "sk-badkeyyy",
      authorization: "Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("rejects malformed API key CRC even when requireApiKey=false", async () => {
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });

    const response = await proxy(request("/v1/models", {
      host: "router.example.com",
      authorization: "Bearer sk-deadbeef-test01-00000000",
    }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("Invalid API key");
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("rejects remote public LLM API with sk_9router sentinel", async () => {
    const response = await proxy(request("/v1/models", {
      host: "router.example.com",
      authorization: "Bearer sk_9router",
    }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("Invalid API key");
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("rejects loopback public LLM API with OAuth bearer when requireApiKey=true", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: true, requireApiKey: true });

    const response = await proxy(request("/v1/models", {
      host: "localhost:20128",
      authorization: "Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig",
    }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("Missing API key");
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("allows loopback public LLM API with sk_9router sentinel without DB lookup", async () => {
    const response = await proxy(request("/v1/models", {
      host: "localhost:20128",
      authorization: "Bearer sk_9router",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("allows loopback public LLM API when revoked gateway Bearer accompanies provider x-api-key", async () => {
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });
    mocks.validateApiKey.mockResolvedValue(false);

    const response = await proxy(request("/v1/models", {
      host: "localhost:20128",
      authorization: `Bearer ${VALID_TEST_KEY}`,
      "x-api-key": "sk-ant-api03-provider-key",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith(VALID_TEST_KEY);
  });

  it("allows loopback public LLM API when revoked gateway x-api-key accompanies OAuth bearer", async () => {
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });
    mocks.validateApiKey.mockResolvedValue(false);

    const response = await proxy(request("/v1/models", {
      host: "localhost:20128",
      "x-api-key": VALID_TEST_KEY,
      authorization: "Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith(VALID_TEST_KEY);
  });

  it("allows loopback public LLM API when stale gateway x-api-key accompanies raw provider Authorization", async () => {
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });

    const response = await proxy(request("/v1/models", {
      host: "localhost:20128",
      "x-api-key": "sk-badkeyyy",
      authorization: "sk-ant-api03-provider-key",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("allows remote public LLM API when valid Bearer accompanies revoked gateway x-api-key", async () => {
    const activeKey = makeTestApiKey();
    mocks.validateApiKey.mockImplementation(async (key) => key === activeKey);

    const response = await proxy(request("/v1/models", {
      host: "router.example.com",
      "x-api-key": VALID_TEST_KEY,
      authorization: `Bearer ${activeKey}`,
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith(VALID_TEST_KEY);
    expect(mocks.validateApiKey).toHaveBeenCalledWith(activeKey);
  });

  it("allows remote public LLM API when valid x-api-key accompanies stale gateway Bearer", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/v1/models", {
      host: "router.example.com",
      "x-api-key": VALID_TEST_KEY,
      authorization: "Bearer sk-badkeyyy",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith(VALID_TEST_KEY);
  });

  it("allows loopback public LLM API when stale gateway Bearer accompanies provider x-api-key", async () => {
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });

    const response = await proxy(request("/v1/models", {
      host: "localhost:20128",
      "x-api-key": "sk-ant-api03-provider-key",
      authorization: "Bearer sk-badkeyyy",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("allows loopback public LLM API when stale gateway Bearer accompanies x-goog-api-key", async () => {
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });

    const response = await proxy(request("/v1/models", {
      host: "localhost:20128",
      "x-goog-api-key": "AIzaSyD-provider-google-key",
      authorization: "Bearer sk-badkeyyy",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("allows loopback public LLM API when stale gateway x-api-key accompanies OAuth bearer", async () => {
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });

    const response = await proxy(request("/v1/models", {
      host: "localhost:20128",
      "x-api-key": "sk-badkeyyy",
      authorization: "Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("allows loopback public LLM API with OAuth bearer when requireApiKey=false", async () => {
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });

    const response = await proxy(request("/v1/models", {
      host: "localhost:20128",
      authorization: "Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("allows loopback public LLM API when x-api-key gateway key accompanies OAuth Bearer", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/v1/models", {
      host: "localhost:20128",
      authorization: "Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig",
      "x-api-key": VALID_TEST_KEY,
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith(VALID_TEST_KEY);
  });

  it("returns Invalid API key when credential header present but invalid on loopback", async () => {
    const response = await proxy(request("/v1/models", {
      host: "localhost:20128",
      authorization: "Bearer sk-deadbeef-test01-00000000",
    }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("Invalid API key");
  });
});

describe("dashboard guard management API access", () => {
  beforeEach(() => {
    useTestApiKeySecret();
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ requireLogin: false });
    mocks.validateApiKey.mockResolvedValue(false);
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
  });

  it("allows management API on verifiable loopback when requireLogin=false and no JWT/CLI token", async () => {
    const response = await proxy(request("/api/keys", {
      host: "localhost:20128",
      origin: "http://localhost:20128",
    }, "127.0.0.1"));

    expect(response).toBe(mocks.nextResponse);
  });

  it("rejects management API when Host is loopback but socket IP is remote", async () => {
    const response = await proxy(request("/api/keys", {
      host: "localhost:20128",
      origin: "http://localhost:20128",
    }, "203.0.113.9"));

    expect(response.status).toBe(401);
  });

  it("rejects management API when Host is loopback but socket IP is unavailable (Host spoofing)", async () => {
    const response = await proxy(request("/api/keys", {
      host: "localhost:20128",
      origin: "http://localhost:20128",
    }));

    expect(response.status).toBe(401);
  });

  it("rejects management API from tunnel host even when requireLogin=false", async () => {
    const response = await proxy(request("/api/translator/send", {
      host: "router.example.com",
    }));

    expect(response.status).toBe(401);
  });
});

describe("dashboard guard local-only access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    mocks.validateApiKey.mockResolvedValue(false);
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
  });

  it("rejects local-only route from non-loopback host without CLI token", async () => {
    const response = await proxy(request("/api/mcp/filesystem/sse", {
      host: "router.example.com",
    }));

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("Local only: CLI token required");
  });

  it("rejects local-only route on loopback when requireLogin=true and no JWT", async () => {
    const response = await proxy(request("/api/mcp/filesystem/sse", {
      host: "localhost:20128",
      origin: "http://localhost:20128",
    }));

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("Local only: CLI token required");
  });

  it("rejects local-only route on loopback when requireLogin=false and no JWT (host-spoofing protection)", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false });

    const response = await proxy(request("/api/cli-tools/antigravity-mitm", {
      host: "localhost:20128",
      origin: "http://localhost:20128",
    }));

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("Local only: CLI token required");
  });

  it("rejects local-only route on bracketed IPv6 loopback when requireLogin=false and no JWT", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false });

    const response = await proxy(request("/api/cli-tools/antigravity-mitm", {
      host: "[::1]:20128",
      origin: "http://[::1]:20128",
    }));

    expect(response.status).toBe(403);
  });

  it("allows local-only route on verifiable loopback when requireLogin=false and valid JWT", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false });
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);

    const cookieReq = {
      nextUrl: { pathname: "/api/cli-tools/antigravity-mitm" },
      headers: new Headers({ host: "localhost:20128", origin: "http://localhost:20128" }),
      cookies: { get: vi.fn(() => ({ value: "valid-jwt" })) },
      url: "http://localhost/api/cli-tools/antigravity-mitm",
      socket: { remoteAddress: "127.0.0.1" },
      ip: "127.0.0.1",
    };

    const response = await proxy(cookieReq);
    expect(response).toBe(mocks.nextResponse);
  });

  it("rejects local-only route when JWT is valid but loopback Host is not verifiable", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false });
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);

    const cookieReq = {
      nextUrl: { pathname: "/api/cli-tools/antigravity-mitm" },
      headers: new Headers({ host: "localhost:20128", origin: "http://localhost:20128" }),
      cookies: { get: vi.fn(() => ({ value: "valid-jwt" })) },
      url: "http://localhost/api/cli-tools/antigravity-mitm",
    };

    const response = await proxy(cookieReq);
    expect(response.status).toBe(403);
  });

  it("allows local-only route on raw IPv6 loopback host when requireLogin=false", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false });

    const localRequest = request("/api/cli-tools/antigravity-mitm", {
      host: "::1",
      origin: "http://[::1]:20128",
    });

    expect(__test__.isLocalRequest(localRequest)).toBe(true);
  });

  it("rejects local-only route from tunnel host even when requireLogin=false", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false });

    const response = await proxy(request("/api/cli-tools/antigravity-mitm", {
      host: "router.example.com",
    }));

    expect(response.status).toBe(403);
  });

  it("rejects local-only route when Origin is non-loopback (CSRF block)", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false });

    const response = await proxy(request("/api/cli-tools/antigravity-mitm", {
      host: "localhost:20128",
      origin: "http://evil.example.com",
    }));

    expect(response.status).toBe(403);
  });

  it("allows local-only route with valid CLI token", async () => {
    const response = await proxy(request("/api/mcp/filesystem/sse", {
      host: "router.example.com",
      "x-9r-cli-token": "cli-token",
    }));

    expect(response).toBe(mocks.nextResponse);
  });

  it("allows tunnel enable on LAN host with valid JWT (not local-only)", async () => {
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);

    const cookieReq = {
      nextUrl: { pathname: "/api/tunnel/enable" },
      headers: new Headers({ host: "192.168.8.201:20128" }),
      cookies: { get: vi.fn(() => ({ value: "valid-jwt" })) },
      url: "http://192.168.8.201:20128/api/tunnel/enable",
    };

    const response = await proxy(cookieReq);
    expect(response).toBe(mocks.nextResponse);
  });
});

describe("dashboard guard helpers", () => {
  it("extracts bearer API keys before x-api-key", () => {
    const apiRequest = request("/v1/chat/completions", {
      authorization: "Bearer bearer-key",
      "x-api-key": "header-key",
    });

    expect(__test__.extractApiKey(apiRequest)).toBe("bearer-key");
  });
});

describe("dashboard guard CLI token timing-safe comparison", () => {
  // cachedCliToken is module-level — it is set to "cli-token" during the first
  // describe block's beforeEach and never cleared. All tests in this suite must
  // use that value as the canonical expected token.
  const CACHED_TOKEN = "cli-token";

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConsistentMachineId.mockResolvedValue(CACHED_TOKEN);
    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    mocks.validateApiKey.mockResolvedValue(false);
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
  });

  it("rejects token shorter than the correct token", async () => {
    const response = await proxy(request("/api/mcp/filesystem/sse", {
      host: "router.example.com",
      "x-9r-cli-token": "short",
    }));

    expect(response.status).toBe(403);
  });

  it("rejects wrong token of identical length", async () => {
    // Same length as "cli-token" (9 chars) but different content.
    const response = await proxy(request("/api/mcp/filesystem/sse", {
      host: "router.example.com",
      "x-9r-cli-token": "cli-XXXXX",
    }));

    expect(response.status).toBe(403);
  });

  it("accepts exact correct CLI token on local-only route", async () => {
    const response = await proxy(request("/api/mcp/filesystem/sse", {
      host: "router.example.com",
      "x-9r-cli-token": CACHED_TOKEN,
    }));

    expect(response).toBe(mocks.nextResponse);
  });

  it("accepts CLI token with surrounding whitespace", async () => {
    const response = await proxy(request("/api/mcp/filesystem/sse", {
      host: "router.example.com",
      "x-9r-cli-token": `  ${CACHED_TOKEN}  `,
    }));

    expect(response).toBe(mocks.nextResponse);
  });
});

describe("dashboard guard tunnel dashboard access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({
      requireLogin: true,
      tunnelDashboardAccess: false,
      tunnelUrl: "http://[::1]:20128",
    });
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
  });

  it("blocks disabled tunnel dashboard access for bracketed IPv6 host", async () => {
    const response = await proxy(request("/dashboard", { host: "[::1]:20128" }));

    expect(response.status).toBe(307);
    expect(String(response.url)).toContain("/login");
  });
});
