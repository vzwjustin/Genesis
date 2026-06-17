import { beforeEach, describe, expect, it, vi } from "vitest";
import { sanitizeProxyPoolForResponse } from "../../src/lib/network/proxyPoolResponse.js";

const mocks = vi.hoisted(() => ({
  getProxyPoolById: vi.fn(),
  updateProxyPool: vi.fn(),
  testProxyUrl: vi.fn(),
  undiciFetch: vi.fn(),
  requireSpawnRouteAuth: vi.fn(),
}));

vi.mock("@/models", () => ({
  getProxyPoolById: mocks.getProxyPoolById,
  updateProxyPool: mocks.updateProxyPool,
}));

vi.mock("@/lib/network/proxyTest", () => ({
  testProxyUrl: mocks.testProxyUrl,
}));

vi.mock("undici", () => ({
  fetch: mocks.undiciFetch,
}));

vi.mock("@/lib/auth/spawnRouteAuth", () => ({
  requireSpawnRouteAuth: mocks.requireSpawnRouteAuth,
}));

function req() {
  return new Request("http://localhost/api/proxy-pools/pool-1/test", { method: "POST" });
}

async function loadRoute() {
  return import("../../src/app/api/proxy-pools/[id]/test/route.js?relay-auth");
}

describe("proxy pool relay auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireSpawnRouteAuth.mockResolvedValue({ ok: true });
    mocks.updateProxyPool.mockResolvedValue({});
  });

  it("sends x-relay-auth when testing managed relay pools", async () => {
    mocks.getProxyPoolById.mockResolvedValue({
      id: "pool-1",
      type: "deno",
      proxyUrl: "https://relay.example.net",
      relayAuthSecret: "relay-secret",
    });
    mocks.undiciFetch.mockResolvedValue({ ok: true, status: 200, statusText: "OK" });

    const { POST } = await loadRoute();
    const response = await POST(req(), { params: Promise.resolve({ id: "pool-1" }) });
    const body = await response.json();

    expect(body.ok).toBe(true);
    expect(mocks.undiciFetch).toHaveBeenCalledWith("https://relay.example.net", expect.objectContaining({
      headers: expect.objectContaining({ "x-relay-auth": "relay-secret" }),
    }));
  });

  it("fails closed before testing a managed relay missing its auth secret", async () => {
    mocks.getProxyPoolById.mockResolvedValue({
      id: "pool-1",
      type: "cloudflare",
      proxyUrl: "https://relay.example.net",
      relayAuthSecret: "",
    });

    const { POST } = await loadRoute();
    const response = await POST(req(), { params: Promise.resolve({ id: "pool-1" }) });
    const body = await response.json();

    expect(body.ok).toBe(false);
    expect(body.error).toBe("Relay auth secret missing");
    expect(mocks.undiciFetch).not.toHaveBeenCalled();
    expect(mocks.updateProxyPool).toHaveBeenCalledWith("pool-1", expect.objectContaining({
      testStatus: "error",
      isActive: false,
      lastError: "Relay auth secret missing",
    }));
  });

  it("does not expose persisted relay auth secrets in proxy-pool API responses", () => {
    const safe = sanitizeProxyPoolForResponse({
      id: "pool-1",
      type: "deno",
      relayAuthSecret: "relay-secret",
    });

    expect(safe.relayAuthSecret).toBeUndefined();
    expect(safe.hasRelayAuthSecret).toBe(true);
  });
});
