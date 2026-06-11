import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyDashboardAuthToken: vi.fn(),
  hasValidCliToken: vi.fn(),
}));

vi.mock("@/lib/auth/dashboardSession", () => ({
  verifyDashboardAuthToken: mocks.verifyDashboardAuthToken,
}));

vi.mock("@/shared/auth/cliToken", () => ({
  hasValidCliToken: mocks.hasValidCliToken,
}));

function makeRequest({ cookies = {}, headers = {} } = {}) {
  return {
    cookies: {
      get: (name) => cookies[name] ? { value: cookies[name] } : undefined,
    },
    headers: new Headers(headers),
  };
}

describe("requireSpawnRouteAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasValidCliToken.mockResolvedValue(false);
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
  });

  it("allows CLI token", async () => {
    mocks.hasValidCliToken.mockResolvedValue(true);
    const { requireSpawnRouteAuth } = await import("../../src/lib/auth/spawnRouteAuth.js");
    const result = await requireSpawnRouteAuth(makeRequest());
    expect(result.ok).toBe(true);
  });

  it("allows valid dashboard JWT on LAN host", async () => {
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);
    const { requireSpawnRouteAuth } = await import("../../src/lib/auth/spawnRouteAuth.js");
    const result = await requireSpawnRouteAuth(makeRequest({ cookies: { auth_token: "jwt" } }));
    expect(result.ok).toBe(true);
  });

  it("rejects unauthenticated requests", async () => {
    const { requireSpawnRouteAuth } = await import("../../src/lib/auth/spawnRouteAuth.js");
    const result = await requireSpawnRouteAuth(makeRequest());
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });
});
