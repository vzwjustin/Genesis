/**
 * Streaming terminal semantics — fail closed on truncated/incomplete streams.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestUsage: vi.fn(() => Promise.resolve()),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/compressionStats.js", () => ({
  recordCompressionStats: vi.fn(() => Promise.resolve()),
}));

vi.mock("open-sse/handlers/chatCore/requestDetail.js", () => ({
  buildRequestDetail: vi.fn((detail, opts) => ({ ...detail, id: opts?.id })),
  extractRequestConfig: vi.fn(() => ({})),
  saveUsageStats: vi.fn(),
}));

import { STREAM_STALL_TIMEOUT_MS } from "../../open-sse/config/runtimeConfig.js";
import { createStreamController, pipeWithDisconnect } from "../../open-sse/utils/streamHandler.js";
import { createSSETransformStreamWithLogger, createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.js";
import { createResponsesApiTransformStream } from "../../open-sse/transformer/responsesTransformer.js";
import { convertResponsesStreamToJson } from "../../open-sse/transformer/streamToJsonConverter.js";
import { buildOnStreamComplete, handleStreamingResponse } from "../../open-sse/handlers/chatCore/streamingHandler.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { saveRequestDetail } from "@/lib/usageDb.js";
import { saveUsageStats } from "open-sse/handlers/chatCore/requestDetail.js";

function sseStream(text) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
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

async function pipeSseThroughTransform(providerSse, transformStream, stall = false) {
  const controller = createStreamController({ provider: "openai", model: "gpt-4" });
  const providerResponse = { body: sseStream(providerSse) };
  const readable = pipeWithDisconnect(providerResponse, transformStream, controller);
  const text = await collectStreamText(readable);
  return text;
}

describe("streamHandler — stall timeout does not fabricate [DONE]", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not inject [DONE] when upstream stalls", async () => {
    const onError = vi.fn();
    const controller = createStreamController({ onError, provider: "openai", model: "gpt-4" });
    const encoder = new TextEncoder();

    const providerResponse = {
      body: new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
        },
      }),
    };
    const transform = new TransformStream({
      transform(chunk, ctrl) { ctrl.enqueue(chunk); },
    });

    const readable = pipeWithDisconnect(providerResponse, transform, controller);
    const reader = readable.getReader();
    await reader.read();

    vi.advanceTimersByTime(STREAM_STALL_TIMEOUT_MS + 100);

    let out = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      out += new TextDecoder().decode(value);
    }

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "stream stall timeout" }));
    expect(out).not.toContain("[DONE]");
  });

  it("handles a null-body upstream response by closing cleanly (no TypeError)", async () => {
    vi.useRealTimers();
    const controller = createStreamController({ provider: "openai", model: "gpt-4" });
    const transform = new TransformStream({
      transform(chunk, ctrl) { ctrl.enqueue(chunk); },
    });

    // providerResponse.body == null (e.g. 204 / HEAD / empty error). The no-body
    // branch must pass the {readable, writable} shape, not a bare ReadableStream,
    // or createDisconnectAwareStream throws on transformStream.readable.getReader().
    const readable = pipeWithDisconnect({ body: null }, transform, controller);
    const reader = readable.getReader();
    const { done } = await reader.read();

    expect(done).toBe(true);
  });
});

describe("stream.js — passthrough terminal semantics", () => {
  it("does not emit [DONE] or mark clean when upstream lacks terminal", async () => {
    const onStreamComplete = vi.fn();
    const sse = [
      'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}',
    ].join("\n");

    const transform = createPassthroughStreamWithLogger("openai", null, "gpt-4", null, null, onStreamComplete, null, FORMATS.OPENAI);
    const out = await pipeSseThroughTransform(sse, transform);
    expect(out).toContain("partial");
    expect(out).not.toContain("[DONE]");
    expect(onStreamComplete).toHaveBeenCalledTimes(1);
    expect(onStreamComplete.mock.calls[0][0].clean).toBe(false);
  });

  it("forwards upstream [DONE] once without duplicating on flush", async () => {
    const onStreamComplete = vi.fn();
    const sse = [
      'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}',
      "data: [DONE]",
    ].join("\n");

    const transform = createPassthroughStreamWithLogger("openai", null, "gpt-4", null, null, onStreamComplete, null, FORMATS.OPENAI);
    const out = await pipeSseThroughTransform(sse, transform);
    expect((out.match(/\[DONE\]/g) || []).length).toBe(1);
    expect(onStreamComplete).toHaveBeenCalledTimes(1);
    expect(onStreamComplete.mock.calls[0][0].clean).toBe(true);
  });

  it("emits [DONE] on flush when finish_reason seen but upstream omitted [DONE]", async () => {
    const sse = [
      'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}',
      'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    ].join("\n");

    const transform = createPassthroughStreamWithLogger("openai", null, "gpt-4", null, null, null, null, FORMATS.OPENAI);
    const out = await pipeSseThroughTransform(sse, transform);
    expect(out).toContain("[DONE]");
  });
});

describe("stream.js — translated flush terminal semantics", () => {
  it("does not emit [DONE] when stream ends without finish_reason", async () => {
    const sse = [
      'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"partial"},"finish_reason":null}]}',
    ].join("\n");

    const transform = createSSETransformStreamWithLogger(
      FORMATS.OPENAI,
      FORMATS.OPENAI,
      "openai"
    );
    const out = await pipeSseThroughTransform(sse, transform);
    expect(out).toContain("partial");
    expect(out).not.toContain("[DONE]");
  });

  it("emits [DONE] when finish_reason is observed", async () => {
    const sse = [
      'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}',
      'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    ].join("\n");

    const transform = createSSETransformStreamWithLogger(
      FORMATS.OPENAI,
      FORMATS.OPENAI,
      "openai"
    );
    const out = await pipeSseThroughTransform(sse, transform);
    expect(out).toContain("[DONE]");
  });

  it("emits [DONE] only once when upstream sends [DONE] sentinel", async () => {
    const sse = [
      'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}',
      "data: [DONE]",
    ].join("\n");

    const transform = createSSETransformStreamWithLogger(
      FORMATS.OPENAI,
      FORMATS.OPENAI,
      "openai"
    );
    const out = await pipeSseThroughTransform(sse, transform);
    expect((out.match(/\[DONE\]/g) || []).length).toBe(1);
  });

  it("fails closed on malformed OpenAI data before a terminal frame", async () => {
    const onStreamComplete = vi.fn();
    const sse = [
      "data: {malformed",
      'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      "data: [DONE]",
    ].join("\n");

    const transform = createSSETransformStreamWithLogger(
      FORMATS.OPENAI,
      FORMATS.OPENAI,
      "openai",
      null,
      null,
      "gpt-4",
      null,
      { messages: [] },
      onStreamComplete,
      null
    );
    await expect(pipeSseThroughTransform(sse, transform)).rejects.toThrow("Malformed SSE data frame");
    expect(onStreamComplete).not.toHaveBeenCalled();
  });

  it("fails closed on malformed Responses data before a terminal frame", async () => {
    const onStreamComplete = vi.fn();
    const sse = [
      "event: response.output_item.done\ndata: {malformed",
      'event: response.completed\ndata: {"response":{"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
      "data: [DONE]",
    ].join("\n\n");

    const transform = createSSETransformStreamWithLogger(
      FORMATS.OPENAI_RESPONSES,
      FORMATS.OPENAI,
      "codex",
      null,
      null,
      "gpt-5-codex",
      null,
      { messages: [] },
      onStreamComplete,
      null
    );
    await expect(pipeSseThroughTransform(sse, transform)).rejects.toThrow("Malformed SSE data frame");
    expect(onStreamComplete).not.toHaveBeenCalled();
  });

  it("fails closed on malformed Gemini data before a terminal frame", async () => {
    const onStreamComplete = vi.fn();
    const sse = [
      "data: {malformed",
      'data: {"response":{"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1}}}',
    ].join("\n");

    const transform = createSSETransformStreamWithLogger(
      FORMATS.ANTIGRAVITY,
      FORMATS.OPENAI,
      "antigravity",
      null,
      null,
      "gemini-model",
      null,
      { messages: [] },
      onStreamComplete,
      null
    );
    await expect(pipeSseThroughTransform(sse, transform)).rejects.toThrow("Malformed SSE data frame");
    expect(onStreamComplete).not.toHaveBeenCalled();
  });

  it("still ignores harmless blank comment and non-data SSE lines", async () => {
    const sse = [
      ": keepalive",
      "event: message",
      "",
      'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}',
      'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      "data:",
    ].join("\n");

    const transform = createSSETransformStreamWithLogger(
      FORMATS.OPENAI,
      FORMATS.OPENAI,
      "openai"
    );
    const out = await pipeSseThroughTransform(sse, transform);
    expect(out).toContain("Hi");
    expect(out).toContain("[DONE]");
  });
});

describe("streamHandler — incomplete callback on error", () => {
  it("invokes onIncomplete when reader errors before transform flush", async () => {
    const onIncomplete = vi.fn();
    const controller = createStreamController({ provider: "openai", model: "gpt-4" });
    const broken = new TransformStream({
      transform() {
        throw new Error("transform blew up");
      },
    });
    const providerResponse = {
      body: sseStream('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'),
    };

    const readable = pipeWithDisconnect(providerResponse, broken, controller, { onIncomplete });
    await expect(collectStreamText(readable)).rejects.toThrow();
    expect(onIncomplete).toHaveBeenCalledTimes(1);
  });

  it("does not run success accounting when translated streaming sees malformed data", async () => {
    vi.clearAllMocks();
    const onRequestSuccess = vi.fn();
    const { onStreamComplete, streamDetailId } = buildOnStreamComplete({
      provider: "openai",
      model: "gpt-4",
      connectionId: "conn-1",
      apiKey: "key-1",
      requestStartTime: Date.now(),
      body: { messages: [] },
      stream: true,
      finalBody: null,
      translatedBody: { messages: [], stream: true },
      clientRawRequest: { endpoint: "/v1/chat/completions" },
      onRequestSuccess,
    });
    const providerResponse = {
      body: sseStream([
        "data: {malformed",
        'data: {"response":{"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1}}}',
      ].join("\n")),
    };

    const result = handleStreamingResponse({
      providerResponse,
      provider: "openai",
      model: "gpt-4",
      sourceFormat: FORMATS.OPENAI,
      targetFormat: FORMATS.ANTIGRAVITY,
      userAgent: "",
      body: { messages: [] },
      stream: true,
      translatedBody: { messages: [], stream: true },
      finalBody: null,
      requestStartTime: Date.now(),
      connectionId: "conn-1",
      apiKey: "key-1",
      clientRawRequest: { endpoint: "/v1/chat/completions" },
      onRequestSuccess,
      reqLogger: null,
      toolNameMap: null,
      streamController: createStreamController({ provider: "openai", model: "gpt-4" }),
      onStreamComplete,
      passthrough: false,
      streamDetailId,
    });

    await expect(result.response.text()).rejects.toThrow("Malformed SSE data frame");
    await Promise.resolve();

    expect(onRequestSuccess).not.toHaveBeenCalled();
    expect(saveUsageStats).not.toHaveBeenCalled();
    expect(saveRequestDetail).not.toHaveBeenCalledWith(expect.objectContaining({ status: "success" }));
  });
});

describe("stream.js — translate flush parsing", () => {
  it("uses targetFormat when parsing a final buffered SSE line", async () => {
    const onStreamComplete = vi.fn();
    const sse = 'data: {"response":{"candidates":[{"content":{"parts":[{"text":"tail"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1}}}';

    const transform = createSSETransformStreamWithLogger(
      FORMATS.ANTIGRAVITY,
      FORMATS.OPENAI,
      "antigravity",
      null,
      null,
      "gemini-model",
      null,
      { messages: [] },
      onStreamComplete,
      null
    );

    const out = await pipeSseThroughTransform(sse, transform);
    expect(out).toContain("tail");
  });
});

describe("responsesTransformer — flush without finish_reason", () => {
  it("emits response.failed instead of response.completed when truncated", async () => {
    const sse = [
      'data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":"partial"},"finish_reason":null}]}',
      "",
    ].join("\n\n");

    const transform = createResponsesApiTransformStream();
    const out = await pipeSseThroughTransform(sse, transform);
    expect(out).toContain("response.failed");
    expect(out).not.toContain("response.completed");
    expect(out).not.toContain("[DONE]");
  });

  it("emits response.completed when finish_reason is present", async () => {
    const sse = [
      'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}',
      'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      "",
    ].join("\n\n");

    const transform = createResponsesApiTransformStream();
    const out = await pipeSseThroughTransform(sse, transform);
    expect(out).toContain("response.completed");
    expect(out).toContain("[DONE]");
  });
});

describe("streamToJsonConverter — index gaps and parse errors", () => {
  it("marks status failed when output indices have gaps", async () => {
    const sse = [
      'event: response.created\ndata: {"response":{"id":"resp_gap","created_at":1700000000}}',
      'event: response.output_item.done\ndata: {"output_index":0,"item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"A"}]}}',
      'event: response.output_item.done\ndata: {"output_index":2,"item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"C"}]}}',
      'event: response.completed\ndata: {"response":{"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
    ].join("\n\n");

    const result = await convertResponsesStreamToJson(sseStream(sse));
    expect(result.status).toBe("failed");
    expect(result.output).toHaveLength(1);
  });

  it("marks status failed on unrecoverable JSON parse errors", async () => {
    const sse = [
      'event: response.created\ndata: {"response":{"id":"resp_bad","created_at":1700000000}}',
      "event: response.output_item.done\ndata: {not-json",
    ].join("\n\n");

    const result = await convertResponsesStreamToJson(sseStream(sse));
    expect(result.status).toBe("failed");
  });
});

describe("handleStreamingResponse — abort/stall marks incomplete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("records incomplete when stream stalls", async () => {
    const onRequestSuccess = vi.fn();
    const { onStreamComplete, streamDetailId } = buildOnStreamComplete({
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
    const reqLogger = {
      appendProviderChunk: vi.fn(),
      appendConvertedChunk: vi.fn(),
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
      reqLogger,
      toolNameMap: null,
      streamController: controller,
      onStreamComplete,
      passthrough: false,
      streamDetailId,
    });

    vi.advanceTimersByTime(STREAM_STALL_TIMEOUT_MS + 100);
    await vi.runAllTimersAsync();

    expect(onRequestSuccess).not.toHaveBeenCalled();
    expect(saveRequestDetail).toHaveBeenCalledWith(
      expect.objectContaining({ status: "incomplete", id: streamDetailId })
    );
  });
});

describe("buildOnStreamComplete — clean flag gates success side effects", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls onRequestSuccess only when clean=true", async () => {
    const onRequestSuccess = vi.fn();
    const onRequestFailed = vi.fn();
    const { onStreamComplete: incomplete } = buildOnStreamComplete({
      provider: "claude",
      model: "claude-3-5",
      connectionId: "conn-1",
      apiKey: "key",
      requestStartTime: Date.now(),
      body: { messages: [] },
      stream: true,
      finalBody: null,
      translatedBody: null,
      clientRawRequest: null,
      onRequestSuccess,
      onRequestFailed,
    });

    incomplete({ content: "partial", thinking: null, clean: false }, null, Date.now());
    expect(onRequestSuccess).not.toHaveBeenCalled();
    expect(onRequestFailed).toHaveBeenCalledTimes(1);
    expect(saveUsageStats).not.toHaveBeenCalled();

    const { onStreamComplete: complete } = buildOnStreamComplete({
      provider: "claude",
      model: "claude-3-5",
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

    complete({ content: "done", thinking: null, clean: true }, { prompt_tokens: 1, completion_tokens: 1 }, Date.now());
    expect(onRequestSuccess).toHaveBeenCalledTimes(1);
    expect(saveUsageStats).toHaveBeenCalledTimes(1);
  });

  it("records incomplete status when clean=false", async () => {
    const { onStreamComplete, streamDetailId } = buildOnStreamComplete({
      provider: "claude",
      model: "claude-3-5",
      connectionId: "conn-1",
      apiKey: "key",
      requestStartTime: Date.now(),
      body: { messages: [] },
      stream: true,
      finalBody: null,
      translatedBody: null,
      clientRawRequest: null,
      onRequestSuccess: null,
    });

    onStreamComplete({ content: "partial", thinking: null, clean: false }, null, Date.now());
    expect(saveRequestDetail).toHaveBeenCalledWith(
      expect.objectContaining({ status: "incomplete", id: streamDetailId })
    );
  });
});
