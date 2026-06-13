import { beforeEach, describe, expect, it, vi } from "vitest";

const nextJson = (body, init = {}) => Response.json(body, { status: init.status || 200 });

function makePutRequest(body) {
  return new Request("http://localhost/api/proxy-pools/pool-deno", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Deno proxy pool update handling", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("uses the same type allowlist when creating proxy pools", async () => {
    const createProxyPool = vi.fn(async (input) => ({ id: "pool-created", ...input }));

    vi.doMock("@/models", () => ({
      createProxyPool,
      getProviderConnections: vi.fn(),
      getProxyPools: vi.fn(),
    }));
    vi.doMock("@/lib/auth/spawnRouteAuth", () => ({
      requireSpawnRouteAuth: vi.fn(async () => ({ ok: true })),
    }));
    vi.doMock("next/server", () => ({
      NextResponse: { json: nextJson },
    }));

    const { POST } = await import("../../src/app/api/proxy-pools/route.js?create-deno");
    const response = await POST(new Request("http://localhost/api/proxy-pools", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "deno-relay",
        proxyUrl: "https://relay.example.deno.net",
        type: "deno",
      }),
    }));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(createProxyPool).toHaveBeenCalledWith(expect.objectContaining({ type: "deno" }));
    expect(body.proxyPool.type).toBe("deno");
  });

  it("rejects unknown create types instead of silently coercing to http", async () => {
    const createProxyPool = vi.fn();

    vi.doMock("@/models", () => ({
      createProxyPool,
      getProviderConnections: vi.fn(),
      getProxyPools: vi.fn(),
    }));
    vi.doMock("@/lib/auth/spawnRouteAuth", () => ({
      requireSpawnRouteAuth: vi.fn(async () => ({ ok: true })),
    }));
    vi.doMock("next/server", () => ({
      NextResponse: { json: nextJson },
    }));

    const { POST } = await import("../../src/app/api/proxy-pools/route.js?create-invalid");
    const response = await POST(new Request("http://localhost/api/proxy-pools", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "bad-relay",
        proxyUrl: "https://relay.example.net",
        type: "socks",
      }),
    }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid proxy pool type");
    expect(createProxyPool).not.toHaveBeenCalled();
  });

  it("preserves type deno when updating a Deno relay pool", async () => {
    const existingPool = {
      id: "pool-deno",
      name: "deno-relay",
      proxyUrl: "https://relay.example.deno.net",
      type: "deno",
      noProxy: "",
      isActive: true,
      strictProxy: true,
    };
    const getProxyPoolById = vi.fn(async () => existingPool);
    const updateProxyPool = vi.fn(async (id, updates) => ({ ...existingPool, ...updates }));

    vi.doMock("@/models", () => ({
      deleteProxyPool: vi.fn(),
      getProviderConnections: vi.fn(),
      getProxyPoolById,
      updateProxyPool,
    }));
    vi.doMock("@/lib/auth/spawnRouteAuth", () => ({
      requireSpawnRouteAuth: vi.fn(async () => ({ ok: true })),
    }));
    vi.doMock("next/server", () => ({
      NextResponse: { json: nextJson },
    }));

    const { PUT } = await import("../../src/app/api/proxy-pools/[id]/route.js?deno-update");
    const response = await PUT(makePutRequest({ name: "renamed relay", type: "deno" }), {
      params: Promise.resolve({ id: "pool-deno" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(updateProxyPool).toHaveBeenCalledWith("pool-deno", {
      name: "renamed relay",
      type: "deno",
    });
    expect(body.proxyPool.type).toBe("deno");
  });

  it("rejects unknown update types instead of silently coercing to http", async () => {
    const getProxyPoolById = vi.fn(async () => ({ id: "pool-deno", type: "deno" }));
    const updateProxyPool = vi.fn();

    vi.doMock("@/models", () => ({
      deleteProxyPool: vi.fn(),
      getProviderConnections: vi.fn(),
      getProxyPoolById,
      updateProxyPool,
    }));
    vi.doMock("@/lib/auth/spawnRouteAuth", () => ({
      requireSpawnRouteAuth: vi.fn(async () => ({ ok: true })),
    }));
    vi.doMock("next/server", () => ({
      NextResponse: { json: nextJson },
    }));

    const { PUT } = await import("../../src/app/api/proxy-pools/[id]/route.js?invalid-type");
    const response = await PUT(makePutRequest({ type: "socks" }), {
      params: Promise.resolve({ id: "pool-deno" }),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid proxy pool type");
    expect(updateProxyPool).not.toHaveBeenCalled();
  });

  it("resolves updated Deno pools as relay runtime config", async () => {
    vi.doMock("@/models", () => ({
      getProxyPoolById: vi.fn(async () => ({
        id: "pool-deno",
        name: "deno-relay",
        proxyUrl: "https://relay.example.deno.net",
        type: "deno",
        noProxy: "localhost",
        isActive: true,
        strictProxy: true,
        relayAuthSecret: "secret",
      })),
    }));

    const { resolveConnectionProxyConfig } = await import("../../src/lib/network/connectionProxy.js?deno-runtime");
    const config = await resolveConnectionProxyConfig({ proxyPoolId: "pool-deno" });

    expect(config.source).toBe("deno");
    expect(config.connectionProxyEnabled).toBe(false);
    expect(config.vercelRelayUrl).toBe("https://relay.example.deno.net");
    expect(config.connectionNoProxy).toBe("localhost");
    expect(config.strictProxy).toBe(true);
    expect(config.relayAuthSecret).toBe("secret");
  });
});
