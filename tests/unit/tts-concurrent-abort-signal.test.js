// Regression: concurrent TTS requests must not clobber each other's abort signal.
// The active signal used to live in a module-level variable; two requests
// interleaving on the event loop would overwrite it (request B steals A's
// signal, A's cleanup nulls out B's). It is now scoped per async context via
// AsyncLocalStorage, so each upstream fetch sees only its own signal.
import { describe, it, expect, vi, beforeEach } from "vitest";

const proxyAwareFetch = vi.hoisted(() => vi.fn());

vi.mock("open-sse/utils/proxyFetch.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    proxyAwareFetch: (...args) => proxyAwareFetch(...args),
  };
});

describe("TTS concurrent abort signal isolation", () => {
  beforeEach(() => {
    vi.resetModules();
    proxyAwareFetch.mockReset();
  });

  it("each request's upstream fetch sees its own signal, not a sibling's", async () => {
    const { handleTtsCore } = await import("../../open-sse/handlers/ttsCore.js");

    const acA = new AbortController();
    const acB = new AbortController();

    // Gate both fetches so they are in flight simultaneously: capture the signal,
    // then resolve only after both calls have entered proxyAwareFetch.
    const seen = [];
    let releaseA, releaseB;
    const gateA = new Promise((r) => { releaseA = r; });
    const gateB = new Promise((r) => { releaseB = r; });

    const audio = () => new Response(JSON.stringify({
      data: { audio: "00010203", status: 2 },
      extra_info: { audio_format: "mp3" },
      base_resp: { status_code: 0, status_msg: "success" },
    }), { status: 200, headers: { "Content-Type": "application/json" } });

    proxyAwareFetch.mockImplementation(async (_url, init) => {
      const which = init?.signal === acA.signal ? "A" : init?.signal === acB.signal ? "B" : "OTHER";
      seen.push(which);
      // Block until both are registered, forcing interleaving.
      if (seen.length === 1) { releaseA(); await gateB; }
      else { releaseB(); await gateA; }
      return audio();
    });

    const call = (provider, signal) => handleTtsCore({
      provider, model: "speech-2.8-hd/English_expressive_narrator",
      input: "hi", credentials: { apiKey: "k" }, responseFormat: "json", signal,
    });

    const [rA, rB] = await Promise.all([call("minimax", acA.signal), call("minimax", acB.signal)]);

    expect(rA.success).toBe(true);
    expect(rB.success).toBe(true);
    // Both signals were observed; neither was undefined nor a cross-request leak.
    expect(seen.sort()).toEqual(["A", "B"]);
    expect(seen).not.toContain("OTHER");
  });
});
