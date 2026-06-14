/**
 * Wave 4 — request-path / streaming / handler audit fixes (efe637a7/bef05e35)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
  saveRequestUsage: vi.fn(() => Promise.resolve()),
}));

vi.mock("open-sse/handlers/chatCore/requestDetail.js", () => ({
  buildRequestDetail: vi.fn((base, overrides) => ({ ...base, ...overrides })),
  extractRequestConfig: vi.fn(() => ({})),
  saveUsageStats: vi.fn(),
}));

const root = join(import.meta.dirname, "..", "..");

function sseStream(text) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

async function collectStreamText(readable) {
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

const { convertResponsesStreamToJson } = await import("../../open-sse/transformer/streamToJsonConverter.js");
const { createResponsesApiTransformStream } = await import("../../open-sse/transformer/responsesTransformer.js");
const { handleForcedSSEToJson } = await import("../../open-sse/handlers/chatCore/sseToJsonHandler.js");
const { handleComboChat, resetComboRotation } = await import("../../open-sse/services/combo.js");
const { compressMessages } = await import("../../open-sse/rtk/index.js");
const { hasAnthropicCacheBreakpoints } = await import("../../open-sse/rtk/cacheBoundary.js");
const { injectCaveman } = await import("../../open-sse/rtk/caveman.js");
const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { buildOnStreamComplete, handleStreamingResponse } = await import("../../open-sse/handlers/chatCore/streamingHandler.js");
const { saveRequestDetail } = await import("@/lib/usageDb.js");

describe("wave4 — responsesTransformer TextDecoder reuse", () => {
  it("reuses a single TextDecoder with stream:true", () => {
    const src = readFileSync(join(root, "open-sse/transformer/responsesTransformer.js"), "utf8");
    expect(src).toMatch(/const decoder = new TextDecoder\(\)/);
    expect(src).toMatch(/decoder\.decode\(chunk,\s*\{\s*stream:\s*true\s*\}\)/);
    expect(src).not.toMatch(/new TextDecoder\(\)\.decode/);
  });

  it("uses choice.index ?? 0 so index 0 is preserved", () => {
    const src = readFileSync(join(root, "open-sse/transformer/responsesTransformer.js"), "utf8");
    expect(src).toMatch(/choice\.index \?\? 0/);
  });

  it("skips redundant close* calls in flush when finishReasonSeen", async () => {
    const sse = [
      'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}',
      'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      "",
    ].join("\n\n");

    const transform = createResponsesApiTransformStream();
    const out = await collectStreamText(sseStream(sse).pipeThrough(transform));
    const doneEvents = out.split("\n\n").filter((block) => /"type":"response\.output_item\.done"/.test(block));
    expect(doneEvents).toHaveLength(1);
    expect(out).toContain("response.completed");
  });
});

describe("wave4 — streamToJsonConverter", () => {
  it("early-return id includes random suffix", async () => {
    const result = await convertResponsesStreamToJson(null);
    expect(result.id).toMatch(/^resp_\d+_[a-z0-9]+$/);
  });

  it("appends colliding output_item at state.items.size slot", async () => {
    const sse = [
      'event: response.output_item.done\ndata: {"output_index":0,"item":{"id":"a","type":"message"}}',
      'event: response.output_item.done\ndata: {"output_index":0,"item":{"id":"b","type":"function_call"}}',
      'event: response.completed\ndata: {"response":{"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
    ].join("\n\n");

    const result = await convertResponsesStreamToJson(sseStream(sse));
    expect(result.status).toBe("completed");
    expect(result.output).toHaveLength(2);
    expect(result.output[0].id).toBe("a");
    expect(result.output[1].id).toBe("b");
  });
});

describe("wave4 — handleForcedSSEToJson trackDone + codex content-type", () => {
  function codexArgs(providerResponse, trackDone = vi.fn()) {
    return {
      providerResponse,
      sourceFormat: "openai",
      provider: "codex",
      model: "gpt-5-codex",
      body: { messages: [{ role: "user", content: "Hi" }], stream: false },
      stream: true,
      translatedBody: {},
      finalBody: null,
      requestStartTime: Date.now(),
      connectionId: "conn-1",
      apiKey: "test-key",
      clientRawRequest: { headers: {}, body: "{}", endpoint: "/v1/chat/completions" },
      onRequestSuccess: vi.fn(),
      trackDone,
      appendLog: vi.fn(),
      passthrough: false,
    };
  }

  it("defers trackDone until after SSE assembly completes", async () => {
    const trackDone = vi.fn();
    const sse = [
      'event: response.created\ndata: {"response":{"id":"resp_ok","created_at":1700000000}}',
      'event: response.output_item.done\ndata: {"output_index":0,"item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Hello"}]}}',
      'event: response.completed\ndata: {"response":{"usage":{"input_tokens":5,"output_tokens":1,"total_tokens":6}}}',
    ].join("\n\n");

    const providerResponse = {
      ok: true,
      headers: new Map([["content-type", "text/event-stream"]]),
      body: sseStream(sse),
    };

    await handleForcedSSEToJson(codexArgs(providerResponse, trackDone));
    expect(trackDone).toHaveBeenCalledTimes(1);
  });

  it("returns null for codex empty content-type when response is not ok", async () => {
    const trackDone = vi.fn();
    const providerResponse = {
      ok: false,
      status: 401,
      headers: new Map(),
      body: sseStream('{"error":"unauthorized"}'),
      text: async () => '{"error":"unauthorized"}',
    };

    const result = await handleForcedSSEToJson(codexArgs(providerResponse, trackDone));
    expect(result).toBeNull();
    expect(trackDone).not.toHaveBeenCalled();
  });

  it("assembles codex SSE when content-type is empty but response is ok", async () => {
    const sse = [
      'event: response.created\ndata: {"response":{"id":"resp_ok","created_at":1700000000}}',
      'event: response.output_item.done\ndata: {"output_index":0,"item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Hi"}]}}',
      'event: response.completed\ndata: {"response":{"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
    ].join("\n\n");

    const providerResponse = {
      ok: true,
      headers: new Map(),
      body: sseStream(sse),
    };

    const result = await handleForcedSSEToJson(codexArgs(providerResponse));
    expect(result?.success).toBe(true);
  });
});

describe("wave4 — combo rotation + errorText", () => {
  beforeEach(() => {
    resetComboRotation();
  });

  it("getRotatedModels does not accept legacy numeric rotation state", () => {
    const src = readFileSync(join(root, "open-sse/services/combo.js"), "utf8");
    expect(src).not.toMatch(/typeof existingState === "number"/);
  });

  it("uses error.message instead of stringifying the error object", async () => {
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "also down" } }), { status: 503 }));

    const log = { info: vi.fn(), warn: vi.fn() };
    const response = await handleComboChat({
      body: {},
      models: ["openai/gpt-4", "openai/gpt-4o"],
      handleSingleModel,
      log,
    });

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.message).toContain("also down");
    expect(body.error.message).not.toContain("[object Object]");
  });
});

describe("wave4 — RTK itemsSnapshot cache floor", () => {
  it("only snapshots items after cacheFloor for restore", () => {
    const src = readFileSync(join(root, "open-sse/rtk/index.js"), "utf8");
    expect(src).toMatch(/if \(i <= cacheFloor\) return null/);
    expect(src).toMatch(/if \(snapshot\[i\] == null\) continue/);
  });

  it("does not compress messages at or before cache boundary", () => {
    const big = "diff --git a/foo b/foo\n" + "+\n".repeat(3000);
    const body = {
      messages: [
        { role: "tool", content: big },
        { role: "user", content: [{ type: "text", text: "cached", cache_control: { type: "ephemeral" } }] },
        { role: "tool", content: big },
      ],
    };
    const beforeCached = body.messages[1].content[0].text.length;
    const beforeTool0 = body.messages[0].content.length;
    const stats = compressMessages(body, true);
    expect(body.messages[1].content[0].text.length).toBe(beforeCached);
    expect(body.messages[0].content.length).toBe(beforeTool0);
    expect(body.messages[2].content.length).toBeLessThan(big.length);
    expect(stats?.hits?.length).toBeGreaterThan(0);
  });
});

describe("wave4 — cacheBoundary Kiro userInputMessage", () => {
  it("detects cache_control nested under userInputMessage", () => {
    const body = {
      conversationState: {
        history: [{
          userInputMessage: {
            content: "cached",
            cache_control: { type: "ephemeral" },
          },
        }],
        currentMessage: { userInputMessage: { content: "current" } },
      },
    };
    expect(hasAnthropicCacheBreakpoints(body)).toBe(true);
  });
});

describe("wave4 — caveman string system append", () => {
  it("appends to string system instead of converting to array", () => {
    const body = { system: "You are helpful.", messages: [{ role: "user", content: "hi" }] };
    injectCaveman(body, FORMATS.CLAUDE, "lite", "claude");
    expect(typeof body.system).toBe("string");
    expect(body.system).toContain("You are helpful.");
  });
});

describe("wave4 — streamingHandler streamDetailId", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires streamDetailId from buildOnStreamComplete (no fallback)", () => {
    const src = readFileSync(join(root, "open-sse/handlers/chatCore/streamingHandler.js"), "utf8");
    expect(src).not.toMatch(/streamDetailId \|\|/);
    expect(src).toContain("{ id: streamDetailId }");
  });

  it("saves placeholder with provided streamDetailId", async () => {
    const ctx = {
      provider: "claude", model: "claude-3-5", connectionId: "c1",
      apiKey: "k", requestStartTime: Date.now(), body: { messages: [] },
      stream: true, finalBody: null, translatedBody: null, clientRawRequest: null,
    };
    const { onStreamComplete, streamDetailId } = buildOnStreamComplete(ctx);
    const fakeSSE = 'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n';
    const providerResponse = new Response(fakeSSE, { headers: { "Content-Type": "text/event-stream" } });
    const reqLogger = {
      logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(),
      logProviderResponse: vi.fn(), logConvertedResponse: vi.fn(), logError: vi.fn(),
    };

    handleStreamingResponse({
      ...ctx, providerResponse,
      sourceFormat: FORMATS.OPENAI, targetFormat: FORMATS.CLAUDE,
      userAgent: "test", reqLogger, toolNameMap: null,
      streamController: { signal: new AbortController().signal, handleComplete: vi.fn(), handleError: vi.fn() },
      onStreamComplete, streamDetailId, passthrough: false,
    });

    const [savedDetail] = saveRequestDetail.mock.calls[0];
    expect(savedDetail.id).toBe(streamDetailId);
  });
});

describe("wave4 — chatCore bearerKey rename", () => {
  it("uses bearerKey instead of shadowed apiKey in passthrough OAuth block", () => {
    const src = readFileSync(join(root, "open-sse/handlers/chatCore.js"), "utf8");
    expect(src).toMatch(/const bearerKey = credentials\?\.accessToken \|\| credentials\?\.apiKey/);
    expect(src).toMatch(/applyCloaking\(translatedBody, bearerKey/);
  });
});
