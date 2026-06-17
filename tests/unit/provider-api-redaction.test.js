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
