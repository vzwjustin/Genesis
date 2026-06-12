/**
 * Regression tests for bug-hunt fixes (compression snapshot, upstream error codes,
 * passthrough cooldown metadata, streaming abort account state, Ollama terminal,
 * SSE assembly caps, cache-safe tool ordering).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseUpstreamError } from "../../open-sse/utils/error.js";
import { transformToOllama } from "../../open-sse/utils/ollamaTransform.js";
import {
  parseSSEToOpenAIResponse,
  parseSSEToGeminiResponse,
} from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";
import { prepareClaudeRequest } from "../../open-sse/translator/helpers/claudeHelper.js";
import { buildOnStreamComplete, handleStreamingResponse } from "../../open-sse/handlers/chatCore/streamingHandler.js";
import { createStreamController } from "../../open-sse/utils/streamHandler.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { snapshotCacheProtectedBody, verifyCacheProtectedBody } from "../../open-sse/rtk/cacheBoundary.js";

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/compressionStats.js", () => ({
  recordCompressionStats: vi.fn(() => Promise.resolve()),
  saveCompressionStats: vi.fn(() => Promise.resolve()),
}));

vi.mock("open-sse/handlers/chatCore/requestDetail.js", () => ({
  buildRequestDetail: vi.fn((detail) => detail),
  extractRequestConfig: vi.fn(() => ({})),
  saveUsageStats: vi.fn(),
}));

async function collectNdjson(response) {
  const text = await response.text();
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
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

describe("parseUpstreamError — errorCode from consumed body", () => {
  it("returns errorCode without re-reading the response body", async () => {
    const body = JSON.stringify({
      error: { type: "invalid_request_error", message: "bad tools", code: "invalid_tool" },
    });
    const response = new Response(body, { status: 400 });
    const { statusCode, message, errorCode } = await parseUpstreamError(response, null);
    expect(statusCode).toBe(400);
    expect(message).toBe("bad tools");
    expect(errorCode).toBe("invalid_tool");
  });

  it("maps executor parseError code field to errorCode", async () => {
    const executor = {
      parseError: () => ({
        status: 401,
        message: "reconnect required",
        code: "reauth_required",
      }),
    };
    const response = new Response("{}", { status: 401 });
    const { errorCode } = await parseUpstreamError(response, executor);
    expect(errorCode).toBe("reauth_required");
  });
});

describe("transformToOllama — single terminal done record", () => {
  it("emits only one done:true line when upstream sends [DONE]", async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n';
    const out = transformToOllama(new Response(sse, { status: 200 }), "llama3.2");
    const lines = await collectNdjson(out);
    const doneLines = lines.filter((line) => line.done === true);
    expect(doneLines).toHaveLength(1);
  });

  it("emits only one done:true line when finish_reason is stop", async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    ].join("\n") + "\n";
    const out = transformToOllama(new Response(sse, { status: 200 }), "llama3.2");
    const lines = await collectNdjson(out);
    const doneLines = lines.filter((line) => line.done === true);
    expect(doneLines).toHaveLength(1);
  });
});

describe("SSE assembly — block size caps", () => {
  it("parseSSEToOpenAIResponse returns null when content exceeds MAX_BLOCK_CHARS", () => {
    const huge = "x".repeat(64 * 1024 * 1024 + 1);
    const sse = [
      `data: {"id":"c1","choices":[{"delta":{"content":"${huge}"},"finish_reason":null}]}`,
      'data: {"id":"c1","choices":[{"delta":{},"finish_reason":"stop"}]}',
    ].join("\n");
    expect(parseSSEToOpenAIResponse(sse, "gpt-4")).toBeNull();
  });

  it("parseSSEToGeminiResponse returns null when merged text exceeds MAX_BLOCK_CHARS", () => {
    const chunkA = "a".repeat(32 * 1024 * 1024);
    const chunkB = "b".repeat(32 * 1024 * 1024 + 1);
    const sse = [
      `data: {"candidates":[{"content":{"role":"model","parts":[{"text":"${chunkA}"}]},"finishReason":"STOP"}]}`,
      `data: {"candidates":[{"content":{"role":"model","parts":[{"text":"${chunkB}"}]},"finishReason":"STOP"}]}`,
      "data: [DONE]",
    ].join("\n");
    expect(parseSSEToGeminiResponse(sse, false)).toBeNull();
  });
});

describe("prepareClaudeRequest — cache-safe tool ordering", () => {
  it("fixes tool ordering after cache prefix without mutating cached messages", () => {
    const body = {
      model: "claude-sonnet-4-5",
      system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: "Read", input: {} },
            { type: "text", text: "cached trailing", cache_control: { type: "ephemeral" } },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t2", name: "Write", input: {} },
            { type: "text", text: "must be removed" },
          ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "ok" }] },
      ],
    };
    const snap = snapshotCacheProtectedBody(body);
    const clone = structuredClone(body);
    prepareClaudeRequest(clone, "claude", "sk-ant-oat-test");
    expect(verifyCacheProtectedBody(clone, snap)).toBe(true);
    const fixed = clone.messages.find((m) => m.content?.some((b) => b.type === "tool_use" && b.id === "t2"));
    expect(fixed.content.some((b) => b.type === "text")).toBe(false);
  });
});

describe("handleStreamingResponse — disconnect does not clear account state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not call onRequestSuccess when client disconnects mid-stream", async () => {
    const onRequestSuccess = vi.fn();
    const { onStreamComplete, streamDetailId, fireRequestSuccess } = buildOnStreamComplete({
      provider: "openai",
      model: "gpt-4",
      connectionId: "conn-1",
      apiKey: "key",
      requestStartTime: Date.now(),
      body: { messages: [] },
      stream: true,
      finalBody: null,
      translatedBody: null,
      clientRawRequest: null,
      onRequestSuccess,
    });

    const controller = createStreamController({ provider: "openai", model: "gpt-4" });
    const providerResponse = {
      body: new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
        },
      }),
    };

    handleStreamingResponse({
      providerResponse,
      provider: "openai",
      model: "gpt-4",
      sourceFormat: FORMATS.OPENAI,
      targetFormat: FORMATS.OPENAI,
      userAgent: "test",
      body: { messages: [] },
      stream: true,
      translatedBody: null,
      finalBody: null,
      requestStartTime: Date.now(),
      connectionId: "conn-1",
      apiKey: "key",
      clientRawRequest: null,
      onRequestSuccess,
      reqLogger: { appendProviderChunk: vi.fn(), appendConvertedChunk: vi.fn() },
      toolNameMap: null,
      streamController: controller,
      onStreamComplete,
      passthrough: false,
      streamDetailId,
      fireRequestSuccess,
    });

    controller.handleDisconnect("client_closed");
    expect(onRequestSuccess).not.toHaveBeenCalled();
  });
});
