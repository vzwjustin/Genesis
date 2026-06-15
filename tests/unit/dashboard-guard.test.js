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
  getSettingsSafe: vi.fn(async () => {
    try {
      return await mocks.getSettings();
    } catch {
      return { requireApiKey: false, requireLogin: true };
    }
  }),
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

function request(pathname, headers = {}, socketIp = null, method = "GET") {
  const normalizedHeaders = new Headers(headers);
  return {
    nextUrl: { pathname },
    method,
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
    const response = await proxy(request("/v1/chat/completions", { host: "localhost:20128" }, "127.0.0.1"));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("rejects loopback public LLM API without API key when requireApiKey=true", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: true, requireApiKey: true });

    const response = await proxy(request("/v1/chat/completions", { host: "localhost:20128" }, "127.0.0.1"));

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

    const response = await proxy(request("/api/v1/chat/completions", { host: "localhost:20128" }, "127.0.0.1"));

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

  it("allows loopback public LLM API with valid local CLI token", async () => {
    const response = await proxy(request("/v1/models", {
      host: "localhost:20128",
      "x-9r-cli-token": "cli-token",
    }, "127.0.0.1"));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("rejects remote public LLM API with stolen CLI token", async () => {
    mocks.getSettings.mockResolvedValue({ requireApiKey: true });

    const response = await proxy(request("/v1/models", {
      host: "router.example.com",
      "x-9r-cli-token": "cli-token",
    }, "203.0.113.9"));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required for remote API access");
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("allows loopback public LLM API without credentials when requireApiKey=false", async () => {
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });

    const response = await proxy(request("/v1/models", {
      host: "localhost:20128",
      origin: "http://localhost:20128",
    }, "127.0.0.1"));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("allows loopback public LLM API when settings are unavailable (default requireApiKey off)", async () => {
    mocks.getSettings.mockRejectedValue(new Error("db unavailable"));

    const response = await proxy(request("/v1/models", { host: "localhost:20128" }, "127.0.0.1"));

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
    }, "127.0.0.1"));

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

  it("rejects remote public LLM API with sk_genesis sentinel", async () => {
    const response = await proxy(request("/v1/models", {
      host: "router.example.com",
      authorization: "Bearer sk_genesis",
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
    }, "127.0.0.1"));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("Missing API key");
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("allows loopback public LLM API with sk_genesis sentinel without DB lookup", async () => {
    const response = await proxy(request("/v1/models", {
      host: "localhost:20128",
      authorization: "Bearer sk_genesis",
    }, "127.0.0.1"));

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
    }, "127.0.0.1"));

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
    }, "127.0.0.1"));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith(VALID_TEST_KEY);
  });

  it("allows loopback public LLM API when stale gateway x-api-key accompanies raw provider Authorization", async () => {
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });

    const response = await proxy(request("/v1/models", {
      host: "localhost:20128",
      "x-api-key": "sk-badkeyyy",
      authorization: "sk-ant-api03-provider-key",
    }, "127.0.0.1"));

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
    }, "127.0.0.1"));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("allows loopback public LLM API when stale gateway Bearer accompanies x-goog-api-key", async () => {
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });

    const response = await proxy(request("/v1/models", {
      host: "localhost:20128",
      "x-goog-api-key": "AIzaSyD-provider-google-key",
      authorization: "Bearer sk-badkeyyy",
    }, "127.0.0.1"));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("allows loopback public LLM API when stale gateway x-api-key accompanies OAuth bearer", async () => {
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });

    const response = await proxy(request("/v1/models", {
      host: "localhost:20128",
      "x-api-key": "sk-badkeyyy",
      authorization: "Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig",
    }, "127.0.0.1"));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("allows loopback public LLM API with OAuth bearer when requireApiKey=false", async () => {
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });

    const response = await proxy(request("/v1/models", {
      host: "localhost:20128",
      authorization: "Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig",
    }, "127.0.0.1"));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("allows loopback public LLM API when x-api-key gateway key accompanies OAuth Bearer", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/v1/models", {
      host: "localhost:20128",
      authorization: "Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig",
      "x-api-key": VALID_TEST_KEY,
    }, "127.0.0.1"));

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

  it("allows management API with valid CLI token on verifiable loopback socket", async () => {
    const response = await proxy(request("/api/keys", {
      host: "localhost:20128",
      "x-9r-cli-token": "cli-token",
    }, "127.0.0.1"));

    expect(response).toBe(mocks.nextResponse);
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
    expect(response.body.error).toBe("CLI token or login required");
  });

  it("rejects local-only route on loopback when requireLogin=true and no JWT", async () => {
    const response = await proxy(request("/api/mcp/filesystem/sse", {
      host: "localhost:20128",
      origin: "http://localhost:20128",
    }));

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("CLI token or login required");
  });

  it("rejects local-only route on loopback when requireLogin=false and no JWT (host-spoofing protection)", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false });

    const response = await proxy(request("/api/cli-tools/antigravity-mitm", {
      host: "localhost:20128",
      origin: "http://localhost:20128",
    }));

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("CLI token or login required");
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

  it("allows local-only route when JWT is valid and browser Origin is loopback (no socket IP)", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false });
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);

    const cookieReq = {
      nextUrl: { pathname: "/api/cli-tools/antigravity-mitm" },
      headers: new Headers({ host: "localhost:20128", origin: "http://localhost:20128" }),
      cookies: { get: vi.fn(() => ({ value: "valid-jwt" })) },
      url: "http://localhost/api/cli-tools/antigravity-mitm",
    };

    const response = await proxy(cookieReq);
    expect(response).toBe(mocks.nextResponse);
  });

  it("rejects local-only route when JWT is valid but Origin is remote", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false });
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);

    const cookieReq = {
      nextUrl: { pathname: "/api/cli-tools/antigravity-mitm" },
      headers: new Headers({
        host: "localhost:20128",
        origin: "http://evil.example.com",
      }),
      cookies: { get: vi.fn(() => ({ value: "valid-jwt" })) },
      url: "http://localhost/api/cli-tools/antigravity-mitm",
    };

    const response = await proxy(cookieReq);
    expect(response.status).toBe(403);
  });

  it("isLocalRequest treats raw IPv6 loopback socket as local", () => {
    const localRequest = request("/api/cli-tools/antigravity-mitm", {
      host: "::1",
      origin: "http://[::1]:20128",
    }, "::1");

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

  it("allows local-only route with valid CLI token from verifiable loopback", async () => {
    const response = await proxy(request("/api/mcp/filesystem/sse", {
      host: "localhost:20128",
      "x-9r-cli-token": "cli-token",
    }, "127.0.0.1"));

    expect(response).toBe(mocks.nextResponse);
  });

  it("allows tunnel enable on LAN host with valid JWT and private socket", async () => {
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);

    const cookieReq = {
      nextUrl: { pathname: "/api/tunnel/enable" },
      method: "POST",
      headers: new Headers({ host: "192.168.8.201:20128" }),
      cookies: { get: vi.fn(() => ({ value: "valid-jwt" })) },
      url: "http://192.168.8.201:20128/api/tunnel/enable",
      socket: { remoteAddress: "192.168.8.50" },
      ip: "192.168.8.50",
    };

    const response = await proxy(cookieReq);
    expect(response).toBe(mocks.nextResponse);
  });

  it("allows local-only route on private LAN with valid JWT and matching socket", async () => {
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);

    const cookieReq = {
      nextUrl: { pathname: "/api/cli-tools/cowork-settings" },
      headers: new Headers({ host: "192.168.8.201:20128" }),
      cookies: { get: vi.fn(() => ({ value: "valid-jwt" })) },
      url: "http://192.168.8.201:20128/api/cli-tools/cowork-settings",
      socket: { remoteAddress: "192.168.8.50" },
      ip: "192.168.8.50",
    };

    const response = await proxy(cookieReq);
    expect(response).toBe(mocks.nextResponse);
  });

  it("rejects local-only route when LAN Host is spoofed by public socket", async () => {
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);

    const cookieReq = {
      nextUrl: { pathname: "/api/cli-tools/cowork-settings" },
      headers: new Headers({ host: "192.168.8.201:20128" }),
      cookies: { get: vi.fn(() => ({ value: "valid-jwt" })) },
      url: "http://192.168.8.201:20128/api/cli-tools/cowork-settings",
      socket: { remoteAddress: "203.0.113.9" },
      ip: "203.0.113.9",
    };

    const response = await proxy(cookieReq);
    expect(response.status).toBe(403);
  });

  it("rejects local-only route from tunnel host even with valid JWT", async () => {
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);

    const cookieReq = {
      nextUrl: { pathname: "/api/cli-tools/antigravity-mitm" },
      headers: new Headers({ host: "router.example.com" }),
      cookies: { get: vi.fn(() => ({ value: "valid-jwt" })) },
      url: "http://router.example.com/api/cli-tools/antigravity-mitm",
    };

    const response = await proxy(cookieReq);
    expect(response.status).toBe(403);
    expect(response.body.error).toBe("CLI token or login required");
  });

  it("blocks local-only route from configured tunnel host before LAN-socket allow", async () => {
    mocks.getSettings.mockResolvedValue({
      requireLogin: true,
      tunnelDashboardAccess: false,
      tunnelUrl: "https://router.example.com",
    });
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);

    const response = await proxy(request("/api/cli-tools/antigravity-mitm", {
      host: "router.example.com",
    }, "192.168.8.50"));

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("Dashboard access via tunnel is disabled");
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

  it("accepts exact correct CLI token on local-only route from verifiable loopback", async () => {
    const response = await proxy(request("/api/mcp/filesystem/sse", {
      host: "localhost:20128",
      "x-9r-cli-token": CACHED_TOKEN,
    }, "127.0.0.1"));

    expect(response).toBe(mocks.nextResponse);
  });

  it("rejects CLI token on local-only route from public host", async () => {
    const response = await proxy(request("/api/mcp/filesystem/sse", {
      host: "router.example.com",
      "x-9r-cli-token": CACHED_TOKEN,
    }));

    expect(response.status).toBe(403);
  });

  it("accepts CLI token with surrounding whitespace on private LAN socket", async () => {
    const response = await proxy(request("/api/mcp/filesystem/sse", {
      host: "192.168.8.201:20128",
      "x-9r-cli-token": `  ${CACHED_TOKEN}  `,
    }, "192.168.8.50"));

    expect(response).toBe(mocks.nextResponse);
  });
});

describe("dashboard guard tunnel dashboard access", () => {
  const tunnelSettings = {
    requireLogin: true,
    tunnelDashboardAccess: false,
    tunnelUrl: "http://[::1]:20128",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue(tunnelSettings);
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
  });

  it("blocks disabled tunnel dashboard access for bracketed IPv6 host", async () => {
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);

    const cookieReq = {
      nextUrl: { pathname: "/dashboard" },
      headers: new Headers({ host: "[::1]:20128" }),
      cookies: { get: vi.fn(() => ({ value: "valid-jwt" })) },
      url: "http://[::1]:20128/dashboard",
    };

    const response = await proxy(cookieReq);
    expect(response.status).toBe(307);
    expect(String(response.url)).toContain("/login");
  });

  it("blocks management API on tunnel host when tunnel dashboard access is disabled", async () => {
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);

    const cookieReq = {
      nextUrl: { pathname: "/api/settings" },
      headers: new Headers({ host: "[::1]:20128" }),
      cookies: { get: vi.fn(() => ({ value: "valid-jwt" })) },
      url: "http://[::1]:20128/api/settings",
    };

    const response = await proxy(cookieReq);
    expect(response.status).toBe(403);
    expect(response.body.error).toBe("Dashboard access via tunnel is disabled");
  });

  it("allows management API on tunnel host with local CLI token when dashboard access is disabled", async () => {
    const response = await proxy(request("/api/settings", {
      host: "[::1]:20128",
      "x-9r-cli-token": "cli-token",
    }, "::1"));

    expect(response).toBe(mocks.nextResponse);
  });

  it("blocks management API on tunnel host with CLI token from public socket", async () => {
    const response = await proxy(request("/api/settings", {
      host: "[::1]:20128",
      "x-9r-cli-token": "cli-token",
    }, "203.0.113.9"));

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("Dashboard access via tunnel is disabled");
  });

  it("allows management API on LAN host with JWT when tunnel dashboard access is disabled", async () => {
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);

    const cookieReq = {
      nextUrl: { pathname: "/api/settings" },
      headers: new Headers({ host: "192.168.8.201:20128" }),
      cookies: { get: vi.fn(() => ({ value: "valid-jwt" })) },
      url: "http://192.168.8.201:20128/api/settings",
    };

    const response = await proxy(cookieReq);
    expect(response).toBe(mocks.nextResponse);
  });

  it("blocks always-protected API on tunnel host when tunnel dashboard access is disabled", async () => {
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);

    const cookieReq = {
      nextUrl: { pathname: "/api/shutdown" },
      method: "POST",
      headers: new Headers({ host: "[::1]:20128" }),
      cookies: { get: vi.fn(() => ({ value: "valid-jwt" })) },
      url: "http://[::1]:20128/api/shutdown",
    };

    const response = await proxy(cookieReq);
    expect(response.status).toBe(403);
    expect(response.body.error).toBe("Dashboard access via tunnel is disabled");
  });

  it("blocks password login POST on tunnel host when tunnel dashboard access is disabled", async () => {
    const response = await proxy(request("/api/auth/login", { host: "[::1]:20128" }, null, "POST"));

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("Dashboard access via tunnel is disabled");
  });

  it("redirects OIDC start on tunnel host when tunnel dashboard access is disabled", async () => {
    const response = await proxy(request("/api/auth/oidc/start", { host: "[::1]:20128" }));

    expect(response.status).toBe(307);
    expect(String(response.url)).toContain("/login?error=tunnel_dashboard_disabled");
  });

  it("redirects OIDC callback on tunnel host when tunnel dashboard access is disabled", async () => {
    const response = await proxy(request("/api/auth/oidc/callback", { host: "[::1]:20128" }));

    expect(response.status).toBe(307);
    expect(String(response.url)).toContain("/login?error=tunnel_dashboard_disabled");
  });

  it("allows OIDC start on LAN host when tunnel dashboard access is disabled", async () => {
    const response = await proxy(request("/api/auth/oidc/start", { host: "192.168.8.201:20128" }));

    expect(response).toBe(mocks.nextResponse);
  });

  it("returns safe auth status defaults on tunnel host when dashboard access is disabled", async () => {
    const response = await proxy(request("/api/auth/status", { host: "[::1]:20128" }));

    expect(response.status).toBe(200);
    expect(response.body.requireLogin).toBe(true);
    expect(response.body.hasPassword).toBe(false);
    expect(response.body.oidcConfigured).toBe(false);
  });

  it("hides tunnel dashboard exposure on require-login for tunnel host when disabled", async () => {
    const response = await proxy(request("/api/settings/require-login", { host: "[::1]:20128" }));

    expect(response.status).toBe(200);
    expect(response.body.tunnelDashboardAccess).toBe(false);
  });
});

describe("dashboard guard cli-tools local-only coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    mocks.validateApiKey.mockResolvedValue(false);
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);
  });

  it("blocks cli-tools settings harvest from public host with JWT only", async () => {
    const cookieReq = {
      nextUrl: { pathname: "/api/cli-tools/claude-settings" },
      method: "GET",
      headers: new Headers({ host: "router.example.com" }),
      cookies: { get: vi.fn(() => ({ value: "valid-jwt" })) },
      url: "http://router.example.com/api/cli-tools/claude-settings",
    };

    const response = await proxy(cookieReq);
    expect(response.status).toBe(403);
    expect(response.body.error).toBe("CLI token or login required");
  });

  it("blocks cli-tools settings from public host even when proxy socket is private", async () => {
    const cookieReq = {
      nextUrl: { pathname: "/api/cli-tools/claude-settings" },
      method: "GET",
      headers: new Headers({ host: "router.example.com" }),
      cookies: { get: vi.fn(() => ({ value: "valid-jwt" })) },
      url: "http://router.example.com/api/cli-tools/claude-settings",
      socket: { remoteAddress: "192.168.8.50" },
      ip: "192.168.8.50",
    };

    const response = await proxy(cookieReq);
    expect(response.status).toBe(403);
    expect(response.body.error).toBe("CLI token or login required");
  });

  it("allows cli-tools settings on private LAN with JWT and matching socket", async () => {
    const cookieReq = {
      nextUrl: { pathname: "/api/cli-tools/codex-settings" },
      method: "GET",
      headers: new Headers({ host: "192.168.8.201:20128" }),
      cookies: { get: vi.fn(() => ({ value: "valid-jwt" })) },
      url: "http://192.168.8.201:20128/api/cli-tools/codex-settings",
      socket: { remoteAddress: "192.168.8.50" },
      ip: "192.168.8.50",
    };

    const response = await proxy(cookieReq);
    expect(response).toBe(mocks.nextResponse);
  });

  it("allows cli-tools settings on LAN machine hostname with JWT and private socket", async () => {
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);

    const cookieReq = {
      nextUrl: { pathname: "/api/cli-tools/claude-settings" },
      method: "GET",
      headers: new Headers({ host: "dietpi:20128" }),
      cookies: { get: vi.fn(() => ({ value: "valid-jwt" })) },
      url: "http://dietpi:20128/api/cli-tools/claude-settings",
      socket: { remoteAddress: "192.168.8.50" },
      ip: "192.168.8.50",
    };

    const response = await proxy(cookieReq);
    expect(response).toBe(mocks.nextResponse);
  });

  it("allows cli-tools settings via LAN IP hairpin (loopback socket, same-origin)", async () => {
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);

    const cookieReq = {
      nextUrl: { pathname: "/api/cli-tools/claude-settings" },
      method: "GET",
      headers: new Headers({
        host: "192.168.8.201:20128",
        "sec-fetch-site": "same-origin",
      }),
      cookies: { get: vi.fn(() => ({ value: "valid-jwt" })) },
      url: "http://192.168.8.201:20128/api/cli-tools/claude-settings",
      socket: { remoteAddress: "127.0.0.1" },
      ip: "127.0.0.1",
    };

    const response = await proxy(cookieReq);
    expect(response).toBe(mocks.nextResponse);
  });

  it("allows cli-tools settings on LAN host with JWT when middleware omits socket IP", async () => {
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);

    const cookieReq = {
      nextUrl: { pathname: "/api/cli-tools/claude-settings" },
      method: "GET",
      headers: new Headers({
        host: "192.168.8.201:20128",
        "sec-fetch-site": "same-origin",
      }),
      cookies: { get: vi.fn(() => ({ value: "valid-jwt" })) },
      url: "http://192.168.8.201:20128/api/cli-tools/claude-settings",
    };

    const response = await proxy(cookieReq);
    expect(response).toBe(mocks.nextResponse);
  });

  it("allows cli-tools settings on machine hostname with JWT when middleware omits socket IP", async () => {
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);

    const cookieReq = {
      nextUrl: { pathname: "/api/cli-tools/claude-settings" },
      method: "GET",
      headers: new Headers({
        host: "dietpi:20128",
        "sec-fetch-site": "same-origin",
      }),
      cookies: { get: vi.fn(() => ({ value: "valid-jwt" })) },
      url: "http://dietpi:20128/api/cli-tools/claude-settings",
    };

    const response = await proxy(cookieReq);
    expect(response).toBe(mocks.nextResponse);
  });

  it("allows cli-tools settings on LAN host with JWT without fetch metadata headers", async () => {
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);

    const cookieReq = {
      nextUrl: { pathname: "/api/cli-tools/all-statuses" },
      method: "GET",
      headers: new Headers({ host: "dietpi:20128" }),
      cookies: { get: vi.fn(() => ({ value: "valid-jwt" })) },
      url: "http://dietpi:20128/api/cli-tools/all-statuses",
    };

    const response = await proxy(cookieReq);
    expect(response).toBe(mocks.nextResponse);
  });

  it("blocks tunnel enable from tunnel host with JWT even when dashboard access is enabled", async () => {
    mocks.getSettings.mockResolvedValue({
      requireLogin: true,
      tunnelDashboardAccess: true,
      tunnelUrl: "http://router.example.com",
    });
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);

    const cookieReq = {
      nextUrl: { pathname: "/api/tunnel/enable" },
      method: "POST",
      headers: new Headers({ host: "router.example.com" }),
      cookies: { get: vi.fn(() => ({ value: "valid-jwt" })) },
      url: "http://router.example.com/api/tunnel/enable",
    };

    const response = await proxy(cookieReq);
    expect(response.status).toBe(403);
  });
});
