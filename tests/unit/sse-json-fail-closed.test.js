/**
 * Tests for SSE→JSON fail-closed assembly (Bugs A/B/C).
 *
 * A truncated or failed upstream stream must return a clear error,
 * never partial/invalid JSON as HTTP 200.
 *
 * - Bug A: convertResponsesStreamToJson keeps the real terminal status
 *   ("in_progress") instead of coercing a missing terminal event to "completed".
 * - Bug B: the Codex/Responses-API branch of handleForcedSSEToJson discards a
 *   non-"completed" assembly and returns BAD_GATEWAY "Incomplete streaming response".
 * - Bug C: parseSSEToOpenAIResponse returns null when content accumulated but no
 *   finish_reason and no [DONE] were seen (truncated Chat-Completions stream).
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
  saveRequestUsage: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/compressionStats.js", () => ({
  recordCompressionStats: vi.fn(() => Promise.resolve()),
}));

vi.mock("open-sse/handlers/chatCore/requestDetail.js", () => ({
  buildRequestDetail: vi.fn(() => ({})),
  extractRequestConfig: vi.fn(() => ({})),
  saveUsageStats: vi.fn(),
}));

const { convertResponsesStreamToJson } = await import("../../open-sse/transformer/streamToJsonConverter.js");
const { parseSSEToOpenAIResponse, parseSSEToClaudeResponse, handleForcedSSEToJson } = await import("../../open-sse/handlers/chatCore/sseToJsonHandler.js");

/** Build a ReadableStream emitting the given SSE text as one chunk. */
function sseStream(text) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

// ===========================================================================
// Bug A: converter does not coerce a missing terminal event to "completed"
// ===========================================================================
describe("convertResponsesStreamToJson — terminal status (Bug A)", () => {
  it("reports status 'completed' for a stream that emits response.completed", async () => {
    const sse = [
      'event: response.created\ndata: {"response":{"id":"resp_1","created_at":1700000000}}',
      'event: response.output_item.done\ndata: {"output_index":0,"item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Hi"}]}}',
      'event: response.completed\ndata: {"response":{"usage":{"input_tokens":3,"output_tokens":1,"total_tokens":4}}}',
      "data: [DONE]",
    ].join("\n\n");

    const result = await convertResponsesStreamToJson(sseStream(sse));
    expect(result.status).toBe("completed");
    expect(result.output[0].content[0].text).toBe("Hi");
  });

  it("keeps status 'in_progress' (not 'completed') when terminal event is missing", async () => {
    const sse = [
      'event: response.created\ndata: {"response":{"id":"resp_2","created_at":1700000000}}',
      'event: response.output_item.done\ndata: {"output_index":0,"item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"partial"}]}}',
    ].join("\n\n");

    const result = await convertResponsesStreamToJson(sseStream(sse));
    expect(result.status).toBe("in_progress");
    expect(result.status).not.toBe("completed");
  });

  it("reports status 'failed' when response.failed is emitted", async () => {
    const sse = [
      'event: response.created\ndata: {"response":{"id":"resp_3","created_at":1700000000}}',
      'event: response.failed\ndata: {"response":{}}',
    ].join("\n\n");

    const result = await convertResponsesStreamToJson(sseStream(sse));
    expect(result.status).toBe("failed");
  });
});

// ===========================================================================
// Bug B: Codex/Responses branch returns error for non-completed status
// ===========================================================================
describe("handleForcedSSEToJson — Codex branch fails closed (Bug B)", () => {
  function codexArgs(providerResponse) {
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
      trackDone: vi.fn(),
      appendLog: vi.fn(),
      passthrough: false,
    };
  }

  it("returns 502 'Incomplete streaming response' when stream is truncated (no terminal event)", async () => {
    const sse = [
      'event: response.created\ndata: {"response":{"id":"resp_t","created_at":1700000000}}',
      'event: response.output_item.done\ndata: {"output_index":0,"item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"partial"}]}}',
    ].join("\n\n");

    const providerResponse = {
      headers: new Map([["content-type", "text/event-stream"]]),
      body: sseStream(sse),
    };
    const args = codexArgs(providerResponse);

    const result = await handleForcedSSEToJson(args);
    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(result.error).toBe("Incomplete streaming response");
    // Must NOT mark the request successful for a truncated stream.
    expect(args.onRequestSuccess).not.toHaveBeenCalled();
  });

  it("returns 502 when stream reports failed status", async () => {
    const sse = [
      'event: response.created\ndata: {"response":{"id":"resp_f","created_at":1700000000}}',
      'event: response.failed\ndata: {"response":{}}',
    ].join("\n\n");

    const providerResponse = {
      headers: new Map([["content-type", "text/event-stream"]]),
      body: sseStream(sse),
    };

    const result = await handleForcedSSEToJson(codexArgs(providerResponse));
    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(result.error).toBe("Incomplete streaming response");
  });

  it("returns success with valid JSON for a completed stream (no regression)", async () => {
    const sse = [
      'event: response.created\ndata: {"response":{"id":"resp_ok","created_at":1700000000}}',
      'event: response.output_item.done\ndata: {"output_index":0,"item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Hello"}]}}',
      'event: response.completed\ndata: {"response":{"usage":{"input_tokens":5,"output_tokens":1,"total_tokens":6}}}',
      "data: [DONE]",
    ].join("\n\n");

    const providerResponse = {
      headers: new Map([["content-type", "text/event-stream"]]),
      body: sseStream(sse),
    };

    const result = await handleForcedSSEToJson(codexArgs(providerResponse));
    expect(result.success).toBe(true);
    expect(result.response.headers.get("Content-Type")).toBe("application/json");
    const json = await result.response.json();
    expect(json.object).toBe("chat.completion");
    expect(json.choices[0].message.content).toBe("Hello");
    expect(json.choices[0].finish_reason).toBe("stop");
  });
});

// ===========================================================================
// Bug C: parseSSEToOpenAIResponse fails closed on missing terminal signal
// ===========================================================================
describe("parseSSEToOpenAIResponse — missing terminal signal (Bug C)", () => {
  it("returns null when content accumulated but no finish_reason and no [DONE]", () => {
    const sse = [
      'data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"},"finish_reason":null}]}',
      'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}',
    ].join("\n");

    expect(parseSSEToOpenAIResponse(sse, "gpt-4")).toBeNull();
  });

  it("does not fabricate finish_reason 'stop' for a truncated stream", () => {
    // Truncated tool-call stream: deltas arrived but no terminal marker.
    const sse =
      'data: {"id":"c2","choices":[{"index":0,"delta":{"role":"assistant","content":"x"},"finish_reason":null}]}';
    expect(parseSSEToOpenAIResponse(sse, "gpt-4")).toBeNull();
  });

  it("returns a completed response when [DONE] is present even without finish_reason", () => {
    const sse = [
      'data: {"id":"c3","choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"}}]}',
      "data: [DONE]",
    ].join("\n");

    const result = parseSSEToOpenAIResponse(sse, "gpt-4");
    expect(result).not.toBeNull();
    expect(result.choices[0].message.content).toBe("Hi");
  });

  it("returns a completed response when finish_reason is present (no regression)", () => {
    const sse = [
      'data: {"id":"c4","choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"},"finish_reason":null}]}',
      'data: {"id":"c4","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    ].join("\n");

    const result = parseSSEToOpenAIResponse(sse, "gpt-4");
    expect(result).not.toBeNull();
    expect(result.choices[0].finish_reason).toBe("stop");
  });

  it("returns null for role-only chunks without terminal signal", () => {
    const sse =
      'data: {"id":"c5","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}';
    expect(parseSSEToOpenAIResponse(sse, "gpt-4")).toBeNull();
  });
});

describe("parseSSEToClaudeResponse — truncated stream fail-closed", () => {
  it("returns null for message_start only without message_stop", () => {
    const sse =
      'data: {"type":"message_start","message":{"id":"msg_x","type":"message","role":"assistant","content":[]}}';
    expect(parseSSEToClaudeResponse(sse)).toBeNull();
  });

  it("returns null when message_delta has stop_reason but message_stop is missing", () => {
    const sse = [
      'data: {"type":"message_start","message":{"id":"msg_x","type":"message","role":"assistant","content":[]}}',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}',
      'data: {"type":"content_block_stop","index":0}',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
    ].join("\n");
    expect(parseSSEToClaudeResponse(sse)).toBeNull();
  });

  it("returns null when content_block_stop is missing (truncated block)", () => {
    const sse = [
      'data: {"type":"message_start","message":{"id":"msg_x","type":"message","role":"assistant","content":[]}}',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}',
      'data: {"type":"message_stop"}',
    ].join("\n");
    expect(parseSSEToClaudeResponse(sse)).toBeNull();
  });

  it("returns null when tool_use input_json_delta is truncated", () => {
    const sse = [
      'data: {"type":"message_start","message":{"id":"msg_t","type":"message","role":"assistant","content":[]}}',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_1","name":"get_weather","input":{}}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":\\"NYC"}}',
      'data: {"type":"content_block_stop","index":0}',
      'data: {"type":"message_stop"}',
    ].join("\n");
    expect(parseSSEToClaudeResponse(sse)).toBeNull();
  });
});
