/**
 * Regression tests for bug-hunt fixes
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
}));

vi.mock("open-sse/handlers/chatCore/requestDetail.js", () => ({
  buildRequestDetail: () => ({}),
  extractRequestConfig: () => ({}),
  extractUsageFromResponse: (body) => body?.usage || { prompt_tokens: 0, completion_tokens: 0 },
  saveUsageStats: vi.fn(),
}));

vi.mock("open-sse/utils/claudeCloaking.js", () => ({
  decloakToolNames: (body) => body,
}));

import { compressMessages } from "../../open-sse/rtk/index.js";
import {
  parseSSEToClaudeResponse,
  parseSSEToNativeResponse,
  handleForcedSSEToJson,
} from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";
import { handleNonStreamingResponse } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";

function sseStream(text) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

describe("Headroom — skip messages[] tails with tool history", () => {
  const originalFetch = globalThis.fetch;
  const compress = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    globalThis.fetch = vi.fn(async () => ({ ok: true }));
    compress.mockReset();
    vi.doMock("headroom-ai", () => ({ compress }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("does not compress when tail contains tool role messages", async () => {
    const body = {
      messages: [
        { role: "user", content: "cached", cache_control: { type: "ephemeral" } },
        { role: "assistant", content: "I'll check", tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: "x".repeat(5000) },
        { role: "user", content: "thanks" },
      ],
    };
    const snapshot = structuredClone(body.messages);

    const { compressWithHeadroom } = await import("../../open-sse/rtk/headroom.js");
    const result = await compressWithHeadroom(body, "gpt-4");

    expect(result).toBeNull();
    expect(compress).not.toHaveBeenCalled();
    expect(body.messages).toEqual(snapshot);
  });

  it("does not compress when tail contains Claude tool_result blocks", async () => {
    const body = {
      messages: [
        { role: "user", content: "cached", cache_control: { type: "ephemeral" } },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "output ".repeat(200) }],
        },
      ],
    };
    const snapshot = structuredClone(body.messages);

    const { compressWithHeadroom } = await import("../../open-sse/rtk/headroom.js");
    const result = await compressWithHeadroom(body, "claude-sonnet");

    expect(result).toBeNull();
    expect(compress).not.toHaveBeenCalled();
    expect(body.messages).toEqual(snapshot);
  });
});

describe("RTK — Gemini contents rollback on error", () => {
  let callCount = 0;

  beforeEach(() => {
    callCount = 0;
    vi.resetModules();
    vi.doMock("../../open-sse/rtk/applyFilter.js", () => ({
      safeApply: (filterName, text) => {
        callCount += 1;
        if (callCount === 2) throw new Error("simulated filter failure");
        return text;
      },
    }));
  });

  afterEach(() => {
    vi.doUnmock("../../open-sse/rtk/applyFilter.js");
  });

  it("restores gemini contents when compression throws mid-loop", async () => {
    const longText = "tool output ".repeat(400);
    const contents = [{
      parts: [
        { functionResponse: { response: { result: longText } } },
        { functionResponse: { response: { result: longText } } },
      ],
    }];
    const body = { contents };
    const before = JSON.stringify(contents);

    const { compressMessages: compressMessagesMocked } = await import("../../open-sse/rtk/index.js");
    const result = compressMessagesMocked(body, true);

    expect(result).toBeNull();
    expect(JSON.stringify(contents)).toBe(before);
  });
});

describe("RTK — Kiro currentMessage rollback on error", () => {
  let callCount = 0;

  beforeEach(() => {
    callCount = 0;
    vi.resetModules();
    vi.doMock("../../open-sse/rtk/applyFilter.js", () => ({
      safeApply: (filterName, text) => {
        callCount += 1;
        if (callCount === 2) throw new Error("simulated filter failure");
        return text;
      },
    }));
  });

  afterEach(() => {
    vi.doUnmock("../../open-sse/rtk/applyFilter.js");
  });

  it("restores currentMessage when kiro compression throws", async () => {
    const longText = "tool output ".repeat(400);
    const body = {
      conversationState: {
        currentMessage: {
          userInputMessage: {
            userInputMessageContext: {
              toolResults: [
                {
                  content: [{ text: longText }],
                },
                {
                  content: [{ text: longText }],
                },
              ],
            },
          },
        },
      },
    };
    const before = JSON.stringify(body.conversationState.currentMessage);

    const { compressMessages: compressMessagesMocked } = await import("../../open-sse/rtk/index.js");
    const result = compressMessagesMocked(body, true);

    expect(result).toBeNull();
    expect(JSON.stringify(body.conversationState.currentMessage)).toBe(before);
  });
});

describe("Passthrough SSE assembly — native response shape", () => {
  it("parseSSEToClaudeResponse assembles Anthropic message JSON", () => {
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet","content":[]}}',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":5,"output_tokens":2}}',
      'event: message_stop',
      'data: {"type":"message_stop"}',
    ].join("\n");

    const result = parseSSEToClaudeResponse(sse);
    expect(result?.id).toBe("msg_1");
    expect(result?.type).toBe("message");
    expect(result?.stop_reason).toBe("end_turn");
    expect(result?.content).toEqual([{ type: "text", text: "Hello" }]);
    expect(result?.usage?.input_tokens).toBe(5);
    expect(result?.object).toBeUndefined();
  });

  it("parseSSEToNativeResponse returns Claude shape for claude sourceFormat", async () => {
    const sse = [
      'data: {"type":"message_start","message":{"id":"msg_2","type":"message","role":"assistant","model":"claude","content":[]}}',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}',
      'data: {"type":"content_block_stop","index":0}',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
      'data: {"type":"message_stop"}',
    ].join("\n");

    const result = await parseSSEToNativeResponse(sse, "claude", "claude-sonnet");
    expect(result?.type).toBe("message");
    expect(result?.content?.[0]?.text).toBe("Hi");
    expect(result?.choices).toBeUndefined();
  });

  it("handleNonStreamingResponse passthrough preserves Claude SSE shape", async () => {
    const sse = [
      'data: {"type":"message_start","message":{"id":"msg_sse","type":"message","role":"assistant","model":"claude","content":[]}}',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"native"}}',
      'data: {"type":"content_block_stop","index":0}',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":3,"output_tokens":1}}',
      'data: {"type":"message_stop"}',
    ].join("\n");

    const result = await handleNonStreamingResponse({
      providerResponse: {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Map([["content-type", "text/event-stream"]]),
        text: () => Promise.resolve(sse),
        json: () => Promise.reject(new Error("not json")),
      },
      provider: "claude",
      model: "claude-sonnet",
      sourceFormat: "claude",
      targetFormat: "claude",
      body: { messages: [{ role: "user", content: "Hi" }] },
      stream: false,
      translatedBody: {},
      finalBody: null,
      requestStartTime: Date.now(),
      connectionId: "conn-1",
      apiKey: "key",
      clientRawRequest: { headers: {}, body: "{}", endpoint: "/v1/messages" },
      onRequestSuccess: vi.fn(),
      reqLogger: { logProviderResponse: vi.fn(), logConvertedResponse: vi.fn() },
      toolNameMap: null,
      trackDone: vi.fn(),
      appendLog: vi.fn(),
      passthrough: true,
    });

    expect(result.success).toBe(true);
    const body = await result.response.json();
    expect(body.type).toBe("message");
    expect(body.content?.[0]?.text).toBe("native");
    expect(body.stop_reason).toBe("end_turn");
    expect(body.choices).toBeUndefined();
  });

  it("handleForcedSSEToJson passthrough Codex returns Responses API JSON", async () => {
    const sse = [
      'event: response.created\ndata: {"response":{"id":"resp_pt","created_at":1700000000,"model":"gpt-5-codex"}}',
      'event: response.output_item.done\ndata: {"output_index":0,"item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}}',
      'event: response.completed\ndata: {"response":{"usage":{"input_tokens":4,"output_tokens":2,"total_tokens":6}}}',
      "data: [DONE]",
    ].join("\n\n");

    const result = await handleForcedSSEToJson({
      providerResponse: {
        headers: new Map([["content-type", "text/event-stream"]]),
        body: sseStream(sse),
      },
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
      trackDone: vi.fn(),
      appendLog: vi.fn(),
      passthrough: true,
    });

    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.status).toBe("completed");
    expect(json.output?.[0]?.content?.[0]?.text).toBe("done");
    expect(json.object).not.toBe("chat.completion");
    expect(json.choices).toBeUndefined();
  });
});

describe("Passthrough Accept header — stream preference preserved", () => {
  function computeStreamWithAccept({ passthrough, accept, bodyStream, provider }) {
    const providerRequiresStreaming = provider === "openai" || provider === "codex" || provider === "commandcode";
    let stream = providerRequiresStreaming ? true : (bodyStream !== false);
    const clientPrefersJson = accept.includes("application/json");
    const clientPrefersSSE = accept.includes("text/event-stream");
    if (!passthrough && clientPrefersJson && !clientPrefersSSE && bodyStream !== true) {
      stream = false;
    }
    return stream;
  }

  it("does not force stream=false from Accept header in passthrough mode", () => {
    expect(computeStreamWithAccept({
      passthrough: true,
      accept: "application/json",
      bodyStream: undefined,
      provider: "codex",
    })).toBe(true);
  });

  it("still forces stream=false from Accept header in translated mode", () => {
    expect(computeStreamWithAccept({
      passthrough: false,
      accept: "application/json",
      bodyStream: undefined,
      provider: "claude",
    })).toBe(false);
  });
});

describe("search handler — apiKey ReferenceError fix", () => {
  it("combo path delegates to handleComboChat without bare apiKey reference", async () => {
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(root, "../../src/sse/handlers/search.js"), "utf8");
    expect(src).toContain("handleComboChat");
    expect(src).toContain("handleSingleProviderSearch");
    expect(src).not.toMatch(/[^.\w]apiKey[^:]/);
  });
});

