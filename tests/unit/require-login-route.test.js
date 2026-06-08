import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  jsonResponse: vi.fn((body, init) => ({ status: init?.status || 200, body })),
}));

vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings }));
vi.mock("next/server", () => ({
  NextResponse: { json: mocks.jsonResponse },
}));

const { GET } = await import("../../src/app/api/settings/require-login/route.js");

describe("require-login route — no sensitive URLs in unauthenticated response", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns requireLogin and tunnelDashboardAccess without tunnelUrl or tailscaleUrl", async () => {
    mocks.getSettings.mockResolvedValue({
      requireLogin: false,
      tunnelDashboardAccess: true,
      tunnelUrl: "https://tunnel.example.com",
      tailscaleUrl: "https://ts.example.com",
    });

    await GET();

    const [body] = mocks.jsonResponse.mock.calls[0];
    expect(body).toHaveProperty("requireLogin");
    expect(body).toHaveProperty("tunnelDashboardAccess");
    expect(body).not.toHaveProperty("tunnelUrl");
    expect(body).not.toHaveProperty("tailscaleUrl");
  });

  it("returns correct requireLogin value when login required", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    await GET();
    const [body] = mocks.jsonResponse.mock.calls[0];
    expect(body.requireLogin).toBe(true);
  });

  it("returns correct requireLogin value when login disabled", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false });
    await GET();
    const [body] = mocks.jsonResponse.mock.calls[0];
    expect(body.requireLogin).toBe(false);
  });

  it("returns requireLogin true on settings error", async () => {
    mocks.getSettings.mockRejectedValue(new Error("db error"));
    await GET();
    const [body] = mocks.jsonResponse.mock.calls[0];
    expect(body.requireLogin).toBe(true);
    expect(body).not.toHaveProperty("tunnelUrl");
    expect(body).not.toHaveProperty("tailscaleUrl");
  });
});
