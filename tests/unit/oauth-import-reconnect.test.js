import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = {
  validateCursor: vi.fn(),
  extractCursorUser: vi.fn(),
  validateKiro: vi.fn(),
  extractKiroEmail: vi.fn(),
  createProviderConnection: vi.fn(),
  updateProviderConnection: vi.fn(),
  getProviderConnectionById: vi.fn(),
};

vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((body, init) => ({
      status: init?.status || 200,
      body,
      json: async () => body,
    })),
  },
}));

vi.mock("@/lib/oauth/services/cursor", () => ({
  CursorService: class {
    validateImportToken = mocks.validateCursor;
    extractUserInfo = mocks.extractCursorUser;
  },
}));

vi.mock("@/lib/oauth/services/kiro", () => ({
  KiroService: class {
    validateImportToken = mocks.validateKiro;
    extractEmailFromJWT = mocks.extractKiroEmail;
  },
}));

vi.mock("@/models", () => ({
  createProviderConnection: mocks.createProviderConnection,
  updateProviderConnection: mocks.updateProviderConnection,
  getProviderConnectionById: mocks.getProviderConnectionById,
}));

vi.mock("@/lib/mitm/autoSetupForProvider", () => ({
  autoSetupMitmForProvider: vi.fn().mockResolvedValue({ attempted: false, skipped: true }),
}));

// Stub the auth gate (cursor/kiro import POST handlers call
// requireSpawnRouteAuth, which reads NextRequest `.cookies` absent on the
// plain Request used here) so the reconnect logic is exercised.
vi.mock("@/lib/auth/spawnRouteAuth", () => ({
  requireSpawnRouteAuth: vi.fn(async () => ({ ok: true })),
}));

describe("OAuth import reconnect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.validateCursor.mockResolvedValue({
      accessToken: "cursor-token",
      machineId: "machine-1",
      expiresIn: 3600,
    });
    mocks.extractCursorUser.mockReturnValue({ email: "cursor@example.com", userId: "u1" });
    mocks.validateKiro.mockResolvedValue({
      accessToken: "kiro-access",
      refreshToken: "kiro-refresh",
      expiresIn: 3600,
      profileArn: "arn:aws:profile",
    });
    mocks.extractKiroEmail.mockReturnValue("kiro@example.com");
    mocks.createProviderConnection.mockResolvedValue({ id: "new-conn", provider: "cursor", email: "cursor@example.com" });
    mocks.updateProviderConnection.mockResolvedValue({ id: "existing-conn", provider: "cursor", email: "cursor@example.com" });
  });

  it("cursor import creates a new connection by default", async () => {
    const { POST } = await import("../../src/app/api/oauth/cursor/import/route.js");
    const req = {
      json: async () => ({ accessToken: "tok", machineId: "mid" }),
    };

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mocks.createProviderConnection).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "cursor", testStatus: "active" }),
    );
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("cursor import updates existing connection when existingConnectionId is provided", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "existing-conn",
      provider: "cursor",
      providerSpecificData: { proxyPoolId: "pool-1" },
    });

    const { POST } = await import("../../src/app/api/oauth/cursor/import/route.js");
    const req = {
      json: async () => ({
        accessToken: "tok",
        machineId: "mid",
        existingConnectionId: "existing-conn",
      }),
    };

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mocks.updateProviderConnection).toHaveBeenCalledWith(
      "existing-conn",
      expect.objectContaining({
        provider: "cursor",
        testStatus: "active",
        lastError: null,
        providerSpecificData: expect.objectContaining({
          proxyPoolId: "pool-1",
          machineId: "machine-1",
        }),
      }),
    );
    expect(mocks.createProviderConnection).not.toHaveBeenCalled();
  });

  it("cursor import rejects mismatched existingConnectionId provider", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "existing-conn",
      provider: "kiro",
    });

    const { POST } = await import("../../src/app/api/oauth/cursor/import/route.js");
    const req = {
      json: async () => ({
        accessToken: "tok",
        machineId: "mid",
        existingConnectionId: "existing-conn",
      }),
    };

    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("kiro import updates existing connection when existingConnectionId is provided", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "kiro-conn",
      provider: "kiro",
      providerSpecificData: { proxyPoolId: "pool-2" },
    });
    mocks.updateProviderConnection.mockResolvedValue({ id: "kiro-conn", provider: "kiro", email: "kiro@example.com" });

    const { POST } = await import("../../src/app/api/oauth/kiro/import/route.js");
    const req = {
      json: async () => ({
        refreshToken: "refresh",
        existingConnectionId: "kiro-conn",
      }),
    };

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mocks.updateProviderConnection).toHaveBeenCalledWith(
      "kiro-conn",
      expect.objectContaining({
        provider: "kiro",
        refreshToken: "kiro-refresh",
        testStatus: "active",
      }),
    );
    expect(mocks.createProviderConnection).not.toHaveBeenCalled();
  });
});
