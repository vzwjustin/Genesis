import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  json: vi.fn((body, init) => ({ status: init?.status || 200, body })),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: mocks.json },
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  updateSettings: mocks.updateSettings,
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: () => ({ value: "session-token" }),
  })),
}));

vi.mock("@/lib/auth/dashboardSession", () => ({
  getDashboardAuthSession: vi.fn(async () => ({ sub: "user" })),
}));

vi.mock("@/lib/network/outboundProxy", () => ({
  applyOutboundProxyEnv: vi.fn(),
}));

vi.mock("open-sse/services/combo.js", () => ({
  resetComboRotation: vi.fn(),
}));

vi.mock("bcryptjs", () => ({
  default: {
    genSalt: vi.fn(),
    hash: vi.fn(),
    compare: vi.fn(),
  },
}));

vi.mock("@/shared/utils/loopbackRequest.js", () => ({
  isVerifiableLoopbackRequest: vi.fn(() => false),
}));

let PATCH;

function patchRequest(body) {
  return { json: vi.fn(async () => body) };
}

describe("settings PATCH remote exposure hardening", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    ({ PATCH } = await import("../../src/app/api/settings/route.js"));
    mocks.getSettings.mockResolvedValue({
      password: "hashed",
      requireLogin: true,
      requireApiKey: true,
      tunnelEnabled: true,
    });
    mocks.updateSettings.mockImplementation(async (body) => body);
  });

  it("rejects disabling requireApiKey while tunnel is enabled", async () => {
    const response = await PATCH(patchRequest({ requireApiKey: false }));

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("API key");
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });

  it("rejects disabling requireLogin while tunnel is enabled", async () => {
    const response = await PATCH(patchRequest({ requireLogin: false }));

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("login");
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });

  it("rejects resetPasswordToDefault while tunnel is enabled", async () => {
    const response = await PATCH(patchRequest({ resetPasswordToDefault: true }));

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("password");
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });

  it("rejects enabling tunnelDashboardAccess without API key requirement", async () => {
    mocks.getSettings.mockResolvedValue({
      password: "hashed",
      requireLogin: true,
      requireApiKey: false,
      tunnelEnabled: false,
      tunnelDashboardAccess: false,
    });

    const response = await PATCH(patchRequest({ tunnelDashboardAccess: true }));

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("API key");
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });

  it("allows disabling requireApiKey when tunnel is not active", async () => {
    mocks.getSettings.mockResolvedValue({
      password: "hashed",
      requireLogin: true,
      requireApiKey: true,
      tunnelEnabled: false,
    });

    const response = await PATCH(patchRequest({ requireApiKey: false }));

    expect(response.status).toBe(200);
    expect(mocks.updateSettings).toHaveBeenCalledWith({ requireApiKey: false });
  });
});
