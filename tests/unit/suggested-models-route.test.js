import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = {
  requireSpawnRouteAuth: vi.fn(async () => ({ ok: true })),
  proxyAwareFetch: vi.fn(),
};

vi.mock("@/lib/auth/spawnRouteAuth", () => ({
  requireSpawnRouteAuth: mocks.requireSpawnRouteAuth,
}));

vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: mocks.proxyAwareFetch,
}));

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

describe("GET /api/providers/suggested-models", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireSpawnRouteAuth.mockResolvedValue({ ok: true });
  });

  it("returns 401 when unauthenticated and never fetches upstream", async () => {
    mocks.requireSpawnRouteAuth.mockResolvedValue({ ok: false, error: "Login required", status: 401 });
    const { GET } = await import("../../src/app/api/providers/suggested-models/route.js");
    const res = await GET({
      url: `http://localhost/api/providers/suggested-models?url=${encodeURIComponent(OPENROUTER_MODELS_URL)}&type=openrouter-free`,
    });

    expect(res.status).toBe(401);
    expect(mocks.proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("returns 400 when url or type is missing", async () => {
    const { GET } = await import("../../src/app/api/providers/suggested-models/route.js");
    const res = await GET({ url: "http://localhost/api/providers/suggested-models?type=openrouter-free" });
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toContain("Missing url or type");
    expect(mocks.proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("returns filtered models for allowed url when authenticated", async () => {
    mocks.proxyAwareFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: "free-model",
            name: "Free Model",
            context_length: 300000,
            pricing: { prompt: "0", completion: "0" },
          },
          {
            id: "paid-model",
            name: "Paid Model",
            context_length: 300000,
            pricing: { prompt: "1", completion: "1" },
          },
        ],
      }),
    });

    const { GET } = await import("../../src/app/api/providers/suggested-models/route.js");
    const res = await GET({
      url: `http://localhost/api/providers/suggested-models?url=${encodeURIComponent(OPENROUTER_MODELS_URL)}&type=openrouter-free`,
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.data).toEqual([{ id: "free-model", name: "Free Model", contextLength: 300000 }]);
    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(OPENROUTER_MODELS_URL);
  });
});
