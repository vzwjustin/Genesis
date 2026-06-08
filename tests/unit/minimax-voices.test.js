import { describe, it, expect, vi, beforeEach } from "vitest";

const proxyAwareFetch = vi.hoisted(() => vi.fn());

vi.mock("open-sse/utils/proxyFetch.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    proxyAwareFetch: (...args) => proxyAwareFetch(...args),
  };
});

vi.mock("../../src/lib/localDb.js", () => ({
  getProviderConnections: vi.fn(),
}));

import { getProviderConnections } from "../../src/lib/localDb.js";

describe("MiniMax voices API", () => {
  beforeEach(() => {
    vi.resetModules();
    proxyAwareFetch.mockReset();
    vi.clearAllMocks();
  });

  it("fetches global MiniMax voices with stored API key", async () => {
    getProviderConnections.mockResolvedValueOnce([{ apiKey: "test-key" }]);
    proxyAwareFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          system_voice: [
            { voice_id: "English_expressive_narrator", voice_name: "Expressive Narrator" },
            { voice_id: "Chinese (Mandarin)_female_beijing", voice_name: "Female Beijing" },
          ],
          voice_cloning: [{ voice_id: "clone_123", voice_name: "My Voice" }],
          base_resp: { status_code: 0, status_msg: "success" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const { GET } = await import("../../src/app/api/media-providers/tts/minimax/voices/route.js");
    const response = await GET(new Request("http://localhost/api/media-providers/tts/minimax/voices"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(getProviderConnections).toHaveBeenCalledWith({ provider: "minimax", isActive: true });
    expect(proxyAwareFetch).toHaveBeenCalledWith(
      "https://api.minimax.io/v1/get_voice",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-key",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ voice_type: "all" }),
      }),
      expect.any(Object)
    );
    expect(body.byLang.English.voices[0].id).toBe("English_expressive_narrator");
    expect(body.byLang["Chinese (Mandarin)"].voices[0].id).toBe("Chinese (Mandarin)_female_beijing");
    expect(body.byLang.Custom.voices[0]).toMatchObject({
      id: "clone_123",
      name: "My Voice · Cloned",
      category: "voice_cloning",
    });
  });

  it("uses minimaxi.cn endpoint for minimax-cn connections", async () => {
    getProviderConnections.mockResolvedValueOnce([
      { apiKey: "cn-key", provider: "minimax-cn", providerSpecificData: {} },
    ]);
    proxyAwareFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          system_voice: [{ voice_id: "Chinese_female", voice_name: "Female" }],
          base_resp: { status_code: 0, status_msg: "success" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const { GET } = await import("../../src/app/api/media-providers/tts/minimax/voices/route.js");
    const response = await GET(
      new Request("http://localhost/api/media-providers/tts/minimax/voices?provider=minimax-cn")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(getProviderConnections).toHaveBeenCalledWith({ provider: "minimax-cn", isActive: true });
    expect(proxyAwareFetch.mock.calls[0][0]).toBe("https://api.minimaxi.com/v1/get_voice");
    expect(body.byLang.Chinese.voices[0].id).toBe("Chinese_female");
  });
});
