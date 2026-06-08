/**
 * Round 11 bug-hunt regression tests
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { FORMATS } from "../../open-sse/translator/formats.js";

const proxyAwareFetch = vi.hoisted(() => vi.fn());

vi.mock("../../open-sse/utils/proxyFetch.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    proxyAwareFetch: (...args) => proxyAwareFetch(...args),
  };
});

async function drainPassthroughStream(transformStream, input) {
  const reader = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(input));
      controller.close();
    },
  }).pipeThrough(transformStream).getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

describe("passthrough stream byte-forward", () => {
  it("forwards usage-only chunks without dropping them", async () => {
    const { createPassthroughStreamWithLogger } = await import("../../open-sse/utils/stream.js");
    const usageChunk = JSON.stringify({
      id: "c1",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: null }],
      usage: { prompt_tokens: 10, completion_tokens: 0 },
    });
    const sse = `data: ${usageChunk}\n\n`;
    const out = await drainPassthroughStream(
      createPassthroughStreamWithLogger("openai", null, "gpt-4", "c1", null, null, null, FORMATS.OPENAI),
      sse
    );
    expect(out).toContain("prompt_tokens");
    expect(out).toContain("data: [DONE]\n\n");
  });

  it("does not inject object/created fields into passthrough chunks", async () => {
    const { createPassthroughStreamWithLogger } = await import("../../open-sse/utils/stream.js");
    const raw = JSON.stringify({ choices: [{ delta: { content: "hi" } }] });
    const sse = `data: ${raw}\n\n`;
    const out = await drainPassthroughStream(
      createPassthroughStreamWithLogger("openai", null, "gpt-4", "c1", null, null, null, FORMATS.OPENAI),
      sse
    );
    expect(out).not.toContain('"object":"chat.completion.chunk"');
    expect(out).toContain(raw);
  });
});

describe("Kiro passthrough response", () => {
  beforeEach(() => {
    vi.resetModules();
    proxyAwareFetch.mockReset();
  });

  it("returns native EventStream without SSE conversion when passthrough=true", async () => {
    const nativeBody = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array([1, 2, 3]));
        c.close();
      },
    });
    const nativeResponse = new Response(nativeBody, {
      status: 200,
      headers: { "Content-Type": "application/vnd.amazon.eventstream" },
    });
    proxyAwareFetch.mockResolvedValue(nativeResponse);

    const { KiroExecutor } = await import("../../open-sse/executors/kiro.js");
    const executor = new KiroExecutor();
    const transformSpy = vi.spyOn(executor, "transformEventStreamToSSE");
    const assembleSpy = vi.spyOn(executor, "assembleEventStreamToJSON");

    const result = await executor.execute({
      model: "claude-sonnet",
      body: { messages: [] },
      stream: true,
      credentials: { accessToken: "tok" },
      log: { debug: vi.fn(), info: vi.fn() },
      passthrough: true,
    });

    expect(transformSpy).not.toHaveBeenCalled();
    expect(assembleSpy).not.toHaveBeenCalled();
    expect(result.response.headers.get("Content-Type")).toContain("eventstream");
  });
});

describe("STT proxy and AssemblyAI auth", () => {
  beforeEach(() => {
    vi.resetModules();
    proxyAwareFetch.mockReset();
  });

  it("routes STT through proxyAwareFetch", async () => {
    proxyAwareFetch.mockReset();
    proxyAwareFetch.mockResolvedValue(
      new Response(JSON.stringify({ text: "hello" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const file = new File(["audio"], "test.wav", { type: "audio/wav" });
    const formData = new FormData();
    formData.append("file", file);
    formData.append("model", "whisper-1");

    const { handleSttCore } = await import("../../open-sse/handlers/sttCore.js");
    await handleSttCore({
      provider: "groq",
      model: "whisper-large-v3",
      formData,
      credentials: {
        apiKey: "sk-test",
        providerSpecificData: { connectionProxyEnabled: true, connectionProxyUrl: "http://proxy:8080" },
      },
    });

    expect(proxyAwareFetch).toHaveBeenCalled();
    expect(proxyAwareFetch.mock.calls[0][2]?.connectionProxyUrl).toBe("http://proxy:8080");
  });

  it("Gemini STT uses x-goog-api-key header instead of query param", async () => {
    proxyAwareFetch.mockReset();
    proxyAwareFetch.mockResolvedValue(
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "hi" }] } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const file = new File(["audio"], "test.wav", { type: "audio/wav" });
    const formData = new FormData();
    formData.append("file", file);

    const { handleSttCore } = await import("../../open-sse/handlers/sttCore.js");
    await handleSttCore({
      provider: "gemini",
      model: "gemini-2.0-flash",
      formData,
      credentials: { apiKey: "secret-key" },
    });

    const [url, init] = proxyAwareFetch.mock.calls[0];
    expect(String(url)).not.toContain("secret-key");
    expect(init.headers["x-goog-api-key"]).toBe("secret-key");
  });
});
