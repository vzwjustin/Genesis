import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  createProviderConnection: vi.fn(),
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn(),
  deleteProviderConnection: vi.fn(),
  getProviderNodeById: vi.fn(),
  getProviderNodes: vi.fn(),
  getProxyPoolById: vi.fn(),
  requireSpawnRouteAuth: vi.fn(),
}));

vi.mock("@/models", () => ({
  getProviderConnections: mocks.getProviderConnections,
  createProviderConnection: mocks.createProviderConnection,
  getProviderConnectionById: mocks.getProviderConnectionById,
  updateProviderConnection: mocks.updateProviderConnection,
  deleteProviderConnection: mocks.deleteProviderConnection,
  getProviderNodeById: mocks.getProviderNodeById,
  getProviderNodes: mocks.getProviderNodes,
  getProxyPoolById: mocks.getProxyPoolById,
}));

vi.mock("@/lib/auth/spawnRouteAuth", () => ({
  requireSpawnRouteAuth: mocks.requireSpawnRouteAuth,
}));

const secretConnection = {
  id: "conn-1",
  provider: "iflow",
  authType: "cookie",
  name: "iflow-account",
  apiKey: "sk-secret",
  accessToken: "access-secret",
  refreshToken: "refresh-secret",
  idToken: "id-secret",
  providerSpecificData: {
    baseUrl: "https://api.example.com/v1",
    proxyPoolId: "pool-1",
    cookie: "BXAuth=secret;",
    copilotToken: "copilot-secret",
    clientSecret: "client-secret",
  },
};

describe("provider API redaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireSpawnRouteAuth.mockResolvedValue({ ok: true });
    mocks.getProviderNodes.mockResolvedValue([]);
  });

  it("redacts top-level and nested credentials from provider list responses", async () => {
    mocks.getProviderConnections.mockResolvedValue([secretConnection]);

    const { GET } = await import("../../src/app/api/providers/route.js?provider-redaction-list");
    const response = await GET(new Request("http://localhost/api/providers"));
    const body = await response.json();
    const [connection] = body.connections;

    expect(connection.apiKey).toBeUndefined();
    expect(connection.accessToken).toBeUndefined();
    expect(connection.refreshToken).toBeUndefined();
    expect(connection.idToken).toBeUndefined();
    expect(connection.providerSpecificData.baseUrl).toBe("https://api.example.com/v1");
    expect(connection.providerSpecificData.proxyPoolId).toBe("pool-1");
    expect(connection.providerSpecificData.cookie).toBeUndefined();
    expect(connection.providerSpecificData.copilotToken).toBeUndefined();
    expect(connection.providerSpecificData.clientSecret).toBeUndefined();
  });

  it("redacts top-level and nested credentials from provider detail responses", async () => {
    mocks.getProviderConnectionById.mockResolvedValue(secretConnection);

    const { GET } = await import("../../src/app/api/providers/[id]/route.js?provider-redaction-detail");
    const response = await GET(new Request("http://localhost/api/providers/conn-1"), {
      params: Promise.resolve({ id: "conn-1" }),
    });
    const body = await response.json();
    const connection = body.connection;

    expect(connection.apiKey).toBeUndefined();
    expect(connection.accessToken).toBeUndefined();
    expect(connection.refreshToken).toBeUndefined();
    expect(connection.idToken).toBeUndefined();
    expect(connection.providerSpecificData.baseUrl).toBe("https://api.example.com/v1");
    expect(connection.providerSpecificData.cookie).toBeUndefined();
    expect(connection.providerSpecificData.copilotToken).toBeUndefined();
    expect(connection.providerSpecificData.clientSecret).toBeUndefined();
  });
});

describe("provider API proxy field validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireSpawnRouteAuth.mockResolvedValue({ ok: true });
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "conn-1",
      provider: "openai-compatible-chat-node",
      authType: "apikey",
      providerSpecificData: { baseUrl: "https://api.example.com/v1" },
    });
  });

  it("rejects proxy pool updates nested inside providerSpecificData", async () => {
    const { PUT } = await import("../../src/app/api/providers/[id]/route.js?nested-proxy-pool");
    const response = await PUT(new Request("http://localhost/api/providers/conn-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerSpecificData: { proxyPoolId: "missing-pool" } }),
    }), {
      params: Promise.resolve({ id: "conn-1" }),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("proxyPoolId must be updated with top-level proxy fields");
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("rejects legacy proxy updates nested inside providerSpecificData", async () => {
    const { PUT } = await import("../../src/app/api/providers/[id]/route.js?nested-legacy-proxy");
    const response = await PUT(new Request("http://localhost/api/providers/conn-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerSpecificData: {
          connectionProxyEnabled: true,
          connectionProxyUrl: "http://proxy.example.com:8080",
        },
      }),
    }), {
      params: Promise.resolve({ id: "conn-1" }),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("connectionProxyEnabled must be updated with top-level proxy fields");
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
  });
});
