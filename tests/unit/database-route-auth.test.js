import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  exportDb: vi.fn(),
  importDb: vi.fn(),
  getSettings: vi.fn(),
  requireSpawnRouteAuth: vi.fn(),
  isDashboardPasswordConfigured: vi.fn(),
  verifyDashboardPasswordForSensitiveAction: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  exportDb: mocks.exportDb,
  importDb: mocks.importDb,
  getSettings: mocks.getSettings,
}));

vi.mock("@/lib/network/outboundProxy", () => ({
  applyOutboundProxyEnv: vi.fn(),
}));

vi.mock("@/lib/auth/spawnRouteAuth", () => ({
  requireSpawnRouteAuth: mocks.requireSpawnRouteAuth,
}));

vi.mock("@/lib/auth/dashboardSession", () => ({
  isDashboardPasswordConfigured: mocks.isDashboardPasswordConfigured,
  verifyDashboardPasswordForSensitiveAction: mocks.verifyDashboardPasswordForSensitiveAction,
}));

function makeRequest({ method = "GET", headers = {}, body } = {}) {
  return {
    method,
    headers: new Headers(headers),
    json: vi.fn(async () => body),
  };
}

describe("settings database route password re-auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireSpawnRouteAuth.mockResolvedValue({ ok: true });
    mocks.exportDb.mockResolvedValue({ tables: {} });
    mocks.importDb.mockResolvedValue(undefined);
    mocks.getSettings.mockResolvedValue({});
    mocks.isDashboardPasswordConfigured.mockResolvedValue(true);
    mocks.verifyDashboardPasswordForSensitiveAction.mockResolvedValue(false);
  });

  it("refuses export when no dashboard password is configured", async () => {
    mocks.isDashboardPasswordConfigured.mockResolvedValue(false);
    const { GET } = await import("../../src/app/api/settings/database/route.js");
    const response = await GET(makeRequest({
      headers: { "x-9r-password": "123456" },
    }));

    expect(response.status).toBe(403);
    expect(mocks.verifyDashboardPasswordForSensitiveAction).not.toHaveBeenCalled();
    expect(mocks.exportDb).not.toHaveBeenCalled();
  });

  it("requires password for export even when CLI token authenticated the route", async () => {
    const { GET } = await import("../../src/app/api/settings/database/route.js");
    const response = await GET(makeRequest({
      headers: {
        "x-9r-cli-token": "cli-token",
        "x-9r-password": "wrong-password",
      },
    }));

    expect(response.status).toBe(401);
    expect(mocks.verifyDashboardPasswordForSensitiveAction).toHaveBeenCalledWith("wrong-password");
    expect(mocks.exportDb).not.toHaveBeenCalled();
  });

  it("allows export when password re-auth succeeds", async () => {
    mocks.verifyDashboardPasswordForSensitiveAction.mockResolvedValue(true);
    const { GET } = await import("../../src/app/api/settings/database/route.js");
    const response = await GET(makeRequest({
      headers: { "x-9r-password": "correct-password" },
    }));

    expect(response.status).toBe(200);
    expect(mocks.verifyDashboardPasswordForSensitiveAction).toHaveBeenCalledWith("correct-password");
    expect(mocks.exportDb).toHaveBeenCalled();
  });

  it("requires password for import even when CLI token authenticated the route", async () => {
    const { POST } = await import("../../src/app/api/settings/database/route.js");
    const response = await POST(makeRequest({
      method: "POST",
      headers: { "x-9r-cli-token": "cli-token" },
      body: { password: "wrong-password", tables: {} },
    }));

    expect(response.status).toBe(401);
    expect(mocks.verifyDashboardPasswordForSensitiveAction).toHaveBeenCalledWith("wrong-password");
    expect(mocks.importDb).not.toHaveBeenCalled();
  });

  it("refuses import when no dashboard password is configured", async () => {
    mocks.isDashboardPasswordConfigured.mockResolvedValue(false);
    const { POST } = await import("../../src/app/api/settings/database/route.js");
    const response = await POST(makeRequest({
      method: "POST",
      body: { password: "123456", tables: {} },
    }));

    expect(response.status).toBe(403);
    expect(mocks.verifyDashboardPasswordForSensitiveAction).not.toHaveBeenCalled();
    expect(mocks.importDb).not.toHaveBeenCalled();
  });
});
