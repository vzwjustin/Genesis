import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = {
  requireSpawnRouteAuth: vi.fn(),
  getProviderConnections: vi.fn(),
  getUserPricingOverrides: vi.fn(),
};

vi.mock("@/lib/auth/spawnRouteAuth", () => ({
  requireSpawnRouteAuth: mocks.requireSpawnRouteAuth,
}));
vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
}));
vi.mock("@/lib/localDb.js", () => ({
  getUserPricingOverrides: mocks.getUserPricingOverrides,
}));

const TTS_ROUTES = [
  "../../src/app/api/media-providers/tts/deepgram/voices/route.js",
  "../../src/app/api/media-providers/tts/elevenlabs/voices/route.js",
  "../../src/app/api/media-providers/tts/inworld/voices/route.js",
  "../../src/app/api/media-providers/tts/minimax/voices/route.js",
];

function req() {
  return { url: "http://localhost/api/x", cookies: { get: () => undefined } };
}

describe("unauthenticated callers cannot exercise stored credentials / read config", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireSpawnRouteAuth.mockResolvedValue({ ok: false, error: "Login required", status: 401 });
  });

  for (const route of TTS_ROUTES) {
    it(`TTS ${route.split("/tts/")[1].split("/")[0]} returns 401 and never reads connections`, async () => {
      const { GET } = await import(route);
      const res = await GET(req());
      expect(res.status).toBe(401);
      expect(mocks.getProviderConnections).not.toHaveBeenCalled();
    });
  }

  it("pricing/user-overrides returns 401 and never reads overrides", async () => {
    const { GET } = await import("../../src/app/api/pricing/user-overrides/route.js");
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(mocks.getUserPricingOverrides).not.toHaveBeenCalled();
  });
});
