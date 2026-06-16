// #12 — the Antigravity MITM handler must propagate the Gemini endpoint verb
// (:streamGenerateContent vs :generateContent) to the router as x-genesis-stream-intent.
// Native Gemini bodies carry no `stream` field, so without this the router force-streams
// every request and a non-streaming :generateContent client receives raw SSE.
import { describe, it, expect, vi, afterEach } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { intercept } = require("../../src/mitm/handlers/antigravity.js");

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks(); });

// Minimal Node ServerResponse stub — pipeSSE only needs writeHead/write/end.
function makeRes() {
  return { headersSent: false, writeHead: vi.fn(), write: vi.fn(), end: vi.fn() };
}

// Capture the headers fetchRouter forwards, and return a tiny valid SSE Response.
function stubRouterFetch() {
  const calls = [];
  global.fetch = vi.fn(async (_url, init) => {
    calls.push(init);
    return new Response("data: {}\n\ndata: [DONE]\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  });
  return calls;
}

const agBody = () => Buffer.from(JSON.stringify({
  model: "orig", userAgent: "antigravity", request: { contents: [] },
}));

describe("#12 Antigravity MITM handler propagates the verb as x-genesis-stream-intent", () => {
  it("sends '0' for a :generateContent (non-streaming) request", async () => {
    const calls = stubRouterFetch();
    const req = { url: "/v1internal:generateContent", headers: { "user-agent": "antigravity" } };
    await intercept(req, makeRes(), agBody(), "gemini-2.0");

    expect(calls).toHaveLength(1);
    expect(calls[0].headers["x-genesis-stream-intent"]).toBe("0");
  });

  it("sends '1' for a :streamGenerateContent (streaming) request — no regression", async () => {
    const calls = stubRouterFetch();
    const req = { url: "/v1internal:streamGenerateContent?alt=sse", headers: { "user-agent": "antigravity" } };
    await intercept(req, makeRes(), agBody(), "gemini-2.0");

    expect(calls).toHaveLength(1);
    expect(calls[0].headers["x-genesis-stream-intent"]).toBe("1");
  });

  it("still forwards to /v1/chat/completions and swaps the mapped model", async () => {
    const calls = stubRouterFetch();
    const req = { url: "/v1internal:generateContent", headers: {} };
    await intercept(req, makeRes(), agBody(), "mapped-model");

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = global.fetch.mock.calls[0];
    expect(String(url)).toContain("/v1/chat/completions");
    expect(JSON.parse(init.body).model).toBe("mapped-model");
  });
});
