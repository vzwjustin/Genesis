import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  getSettingsSafe: vi.fn(),
  getDashboardAuthSession: vi.fn(),
  cookiesGet: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  getSettingsSafe: mocks.getSettingsSafe,
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: mocks.cookiesGet,
  })),
}));

vi.mock("@/lib/auth/dashboardSession", () => ({
  getDashboardAuthSession: mocks.getDashboardAuthSession,
}));

function loopbackRequest() {
  return {
    headers: new Headers({ host: "localhost:20128" }),
    socket: { remoteAddress: "127.0.0.1" },
  };
}

describe("requireDashboardApiAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cookiesGet.mockReturnValue(undefined);
    mocks.getDashboardAuthSession.mockResolvedValue(null);
    mocks.getSettingsSafe.mockResolvedValue({ requireLogin: false });
  });

  it("allows verifiable loopback when requireLogin=false and no session", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false });
    const { requireDashboardApiAuth } = await import("../../src/lib/auth/dashboardApiAuth.js");
    const result = await requireDashboardApiAuth(loopbackRequest());
    expect(result.ok).toBe(true);
  });

  it("requires session when requireLogin=true", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    const { requireDashboardApiAuth } = await import("../../src/lib/auth/dashboardApiAuth.js");
    const result = await requireDashboardApiAuth(loopbackRequest());
    expect(result.ok).toBe(false);
    expect(result.response.status).toBe(401);
  });

  it("fail closed on DB error — rejects loopback bypass without session", async () => {
    mocks.getSettings.mockRejectedValue(new Error("db unavailable"));
    mocks.getSettingsSafe.mockResolvedValue({ requireLogin: false });
    const { requireDashboardApiAuth } = await import("../../src/lib/auth/dashboardApiAuth.js");
    const result = await requireDashboardApiAuth(loopbackRequest());
    expect(result.ok).toBe(false);
    expect(result.response.status).toBe(401);
  });

  it("allows loopback with valid session when DB read throws", async () => {
    mocks.getSettings.mockRejectedValue(new Error("db unavailable"));
    mocks.getSettingsSafe.mockResolvedValue({ requireLogin: false });
    mocks.cookiesGet.mockReturnValue({ value: "valid-jwt" });
    mocks.getDashboardAuthSession.mockResolvedValue({ authenticated: true });
    const { requireDashboardApiAuth } = await import("../../src/lib/auth/dashboardApiAuth.js");
    const result = await requireDashboardApiAuth(loopbackRequest());
    expect(result.ok).toBe(true);
  });
});
