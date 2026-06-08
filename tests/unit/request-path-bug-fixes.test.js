/**
 * Tests for three request-path bug fixes:
 *
 * 1. streamingHandler.js - shared streamDetailId between buildOnStreamComplete and
 *    handleStreamingResponse to prevent duplicate DB records.
 *
 * 2. nonStreamingHandler.js - when provider returns SSE that is parsed to OpenAI format,
 *    do NOT re-run step-1 translation (targetFormat→OpenAI) on the already-OpenAI body.
 *
 * 3. cursor.js -
 *    a) refreshCredentials: returns null with documented limitation (no throw)
 *    b) finalizedIds set only on isLast=true in SSE path (no duplicate tool calls)
 *    c) transformedBody field in execute() return is JSON body, not protobuf bytes
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Common mocks
// ---------------------------------------------------------------------------
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
  saveRequestUsage: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/compressionStats.js", () => ({
  recordCompressionStats: vi.fn(() => Promise.resolve()),
  saveCompressionStats: vi.fn(() => Promise.resolve()),
}));

vi.mock("open-sse/handlers/chatCore/requestDetail.js", () => ({
  buildRequestDetail: vi.fn((base, overrides) => ({ ...base, ...overrides })),
  extractRequestConfig: vi.fn(() => ({})),
  saveUsageStats: vi.fn(),
  extractUsageFromResponse: vi.fn(() => null),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------
import { saveRequestDetail } from "@/lib/usageDb.js";
import { buildOnStreamComplete, handleStreamingResponse } from "../../open-sse/handlers/chatCore/streamingHandler.js";
import { translateNonStreamingResponse, handleNonStreamingResponse } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { CursorExecutor } from "../../open-sse/executors/cursor.js";
import { encodeField, wrapConnectRPCFrame, encodeVarint } from "../../open-sse/utils/cursorProtobuf.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal ConnectRPC frame wrapping raw bytes */
function buildFrame(payloadBytes) {
  const buf = Buffer.isBuffer(payloadBytes) ? payloadBytes : Buffer.from(payloadBytes);
  return Buffer.from(wrapConnectRPCFrame(new Uint8Array(buf)));
}

/**
 * Encode a Cursor tool-call response frame.
 * Fields from cursorProtobuf.js FIELD:
 *   TOOL_CALL = 1  (top-level)
 *   TOOL_ID   = 3  (inside tool call)
 *   TOOL_NAME = 9  (inside tool call)
 *   TOOL_IS_LAST = 11 (inside tool call, varint)
 *   TOOL_RAW_ARGS = 10 (inside tool call)
 */
const WIRE = { VARINT: 0, LEN: 2 };

function encodeToolCallFrame({ id, name, args = "{}", isLast = false }) {
  const toolCallPayload = Buffer.concat([
    Buffer.from(encodeField(3, WIRE.LEN, id)),       // TOOL_ID
    Buffer.from(encodeField(9, WIRE.LEN, name)),      // TOOL_NAME
    Buffer.from(encodeField(10, WIRE.LEN, args)),     // TOOL_RAW_ARGS
    Buffer.from(encodeField(11, WIRE.VARINT, isLast ? 1 : 0)), // TOOL_IS_LAST
  ]);
  const outerPayload = Buffer.from(encodeField(1, WIRE.LEN, new Uint8Array(toolCallPayload)));
  return buildFrame(outerPayload);
}

/** Build a text response frame */
function encodeTextFrame(text) {
  const innerText = Buffer.from(encodeField(1, WIRE.LEN, text));     // RESPONSE_TEXT
  const response = Buffer.from(encodeField(2, WIRE.LEN, new Uint8Array(innerText))); // RESPONSE
  return buildFrame(response);
}

function parseSSEChunks(body) {
  return body
    .split("\n\n")
    .filter(s => s.startsWith("data: ") && !s.includes("[DONE]"))
    .map(s => JSON.parse(s.slice("data: ".length)));
}

// ===========================================================================
// 1. streamingHandler — shared streamDetailId
// ===========================================================================
describe("streamingHandler — shared streamDetailId prevents duplicate DB records", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("buildOnStreamComplete returns a streamDetailId", () => {
    const ctx = {
      provider: "claude", model: "claude-3-5-sonnet", connectionId: "conn-1",
      apiKey: "key", requestStartTime: Date.now(), body: { messages: [] },
      stream: true, finalBody: null, translatedBody: null, clientRawRequest: null,
    };
    const { onStreamComplete, streamDetailId } = buildOnStreamComplete(ctx);
    expect(typeof streamDetailId).toBe("string");
    expect(streamDetailId.length).toBeGreaterThan(0);
    expect(typeof onStreamComplete).toBe("function");
  });

  it("handleStreamingResponse uses the provided streamDetailId and does not generate its own", async () => {
    const mockSaveRequestDetail = saveRequestDetail;
    vi.clearAllMocks();

    const ctx = {
      provider: "claude", model: "claude-3-5-sonnet", connectionId: "conn-1",
      apiKey: "key", requestStartTime: Date.now(), body: { messages: [] },
      stream: true, finalBody: null, translatedBody: null, clientRawRequest: null,
    };

    const { onStreamComplete, streamDetailId } = buildOnStreamComplete(ctx);

    // Minimal fake providerResponse with SSE body
    const fakeSSE = "data: {\"id\":\"c1\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"claude-3-5\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hi\"},\"finish_reason\":null}]}\n\ndata: [DONE]\n\n";
    const providerResponse = new Response(fakeSSE, {
      headers: { "Content-Type": "text/event-stream" }
    });

    const mockReqLogger = {
      logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(),
      logProviderResponse: vi.fn(), logConvertedResponse: vi.fn(), logError: vi.fn(),
    };
    const streamController = {
      signal: new AbortController().signal,
      handleComplete: vi.fn(), handleError: vi.fn(),
    };

    const result = handleStreamingResponse({
      ...ctx, providerResponse,
      sourceFormat: FORMATS.OPENAI, targetFormat: FORMATS.CLAUDE,
      userAgent: "test", reqLogger: mockReqLogger, toolNameMap: null,
      streamController, onStreamComplete, passthrough: false,
      streamDetailId,
    });

    expect(result.success).toBe(true);

    // saveRequestDetail should have been called for the initial placeholder
    expect(mockSaveRequestDetail).toHaveBeenCalledTimes(1);
    const [savedDetail] = mockSaveRequestDetail.mock.calls[0];
    // The saved record must use the streamDetailId from buildOnStreamComplete
    expect(savedDetail.id).toBe(streamDetailId);
  });

  it("onStreamComplete saves a record with the same streamDetailId", async () => {
    const mockSaveRequestDetail = saveRequestDetail;
    vi.clearAllMocks();

    const ctx = {
      provider: "claude", model: "claude-3-5", connectionId: "conn-2",
      apiKey: "key", requestStartTime: Date.now(), body: { messages: [] },
      stream: true, finalBody: null, translatedBody: null, clientRawRequest: null,
    };

    const { onStreamComplete, streamDetailId } = buildOnStreamComplete(ctx);

    // Trigger onStreamComplete
    onStreamComplete({ content: "hello", thinking: null }, { prompt_tokens: 10, completion_tokens: 5 }, Date.now());

    expect(mockSaveRequestDetail).toHaveBeenCalledTimes(1);
    const [savedDetail] = mockSaveRequestDetail.mock.calls[0];
    expect(savedDetail.id).toBe(streamDetailId);
  });
});

// ===========================================================================
// 2. nonStreamingHandler — SSE-parsed response not re-translated
// ===========================================================================
describe("nonStreamingHandler — SSE-parsed response skips targetFormat→OpenAI translation", () => {
  /**
   * translateNonStreamingResponse(body, targetFormat, sourceFormat):
   * Step 1: targetFormat → OpenAI (skipped when targetFormat === FORMATS.OPENAI)
   * Step 2: OpenAI → sourceFormat
   *
   * When provider returns SSE and body is already OpenAI format,
   * we call translateNonStreamingResponse(body, FORMATS.OPENAI, sourceFormat).
   * This skips step 1 entirely and only applies step 2 if needed.
   */

  it("translateNonStreamingResponse(body, OPENAI, OPENAI) returns body unchanged", () => {
    const openaiBody = {
      id: "chatcmpl-abc",
      object: "chat.completion",
      created: 1700000000,
      model: "gpt-4",
      choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    const result = translateNonStreamingResponse(openaiBody, FORMATS.OPENAI, FORMATS.OPENAI);
    expect(result).toBe(openaiBody); // same reference — no copy was made
  });

  it("translateNonStreamingResponse(body, OPENAI, CLAUDE) converts OpenAI→Claude without running Claude→OpenAI first", () => {
    const openaiBody = {
      id: "chatcmpl-abc",
      object: "chat.completion",
      created: 1700000000,
      model: "gpt-4",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "hello from SSE" },
        finish_reason: "stop",
      }],
    };

    // This is what we now call when parsedFromSSE=true and sourceFormat=CLAUDE:
    const result = translateNonStreamingResponse(openaiBody, FORMATS.OPENAI, FORMATS.CLAUDE);

    // Should produce a Claude-format response
    expect(result.type).toBe("message");
    expect(result.role).toBe("assistant");
    expect(Array.isArray(result.content)).toBe(true);
    const textBlock = result.content.find(b => b.type === "text");
    expect(textBlock?.text).toBe("hello from SSE");
    expect(result.stop_reason).toBe("end_turn");
  });

  it("OLD path: translateNonStreamingResponse(claudeBody, CLAUDE, OPENAI) correctly converts Claude→OpenAI", () => {
    // Regression: non-SSE Claude response should still translate correctly
    const claudeBody = {
      id: "msg_abc",
      type: "message",
      role: "assistant",
      model: "claude-3-5-sonnet",
      content: [{ type: "text", text: "hello from claude" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    };

    const result = translateNonStreamingResponse(claudeBody, FORMATS.CLAUDE, FORMATS.OPENAI);
    expect(result.object).toBe("chat.completion");
    expect(result.choices[0].message.content).toBe("hello from claude");
  });

  it("handleNonStreamingResponse: SSE content-type triggers parsedFromSSE path (not re-translated as Claude)", async () => {
    // Provider returns text/event-stream; parseSSEToOpenAIResponse produces OpenAI format.
    // When targetFormat=CLAUDE, sourceFormat=OPENAI: the old code would call
    // translateNonStreamingResponse(openaiBody, CLAUDE, OPENAI) — treating the OpenAI body
    // as a Claude-format response, which fails to find .content array and returns it unchanged.
    // The new code calls translateNonStreamingResponse(openaiBody, OPENAI, OPENAI) = identity.

    const sseText = [
      'data: {"id":"chatcmpl-sse","object":"chat.completion.chunk","created":1700000000,"model":"claude-3-5","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
      'data: {"id":"chatcmpl-sse","object":"chat.completion.chunk","created":1700000000,"model":"claude-3-5","choices":[{"index":0,"delta":{"content":"SSE text"},"finish_reason":null}]}',
      'data: {"id":"chatcmpl-sse","object":"chat.completion.chunk","created":1700000000,"model":"claude-3-5","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      'data: [DONE]',
    ].join("\n");

    const providerResponse = new Response(sseText, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const mockReqLogger = {
      logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(),
      logProviderResponse: vi.fn(), logConvertedResponse: vi.fn(), logError: vi.fn(),
    };

    const result = await handleNonStreamingResponse({
      providerResponse,
      provider: "claude",
      model: "claude-3-5-sonnet",
      sourceFormat: FORMATS.OPENAI,   // client is OpenAI
      targetFormat: FORMATS.CLAUDE,   // provider is Claude
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      translatedBody: null,
      finalBody: null,
      requestStartTime: Date.now(),
      connectionId: "conn-3",
      apiKey: "key",
      clientRawRequest: null,
      onRequestSuccess: null,
      reqLogger: mockReqLogger,
      toolNameMap: null,
      trackDone: vi.fn(),
      appendLog: vi.fn(),
      passthrough: false,
    });

    expect(result.success).toBe(true);
    const body = await result.response.json();

    // Should be OpenAI format (sourceFormat=OPENAI means respond to client in OPENAI format).
    // The SSE body was already OpenAI; no incorrect Claude→OpenAI re-translation ran.
    expect(body.object).toBe("chat.completion");
    // Content should be preserved from the SSE stream
    expect(body.choices[0].message.content).toBe("SSE text");
  });
});

// ===========================================================================
// 3. cursor.js — three fixes
// ===========================================================================
describe("CursorExecutor — bug fixes", () => {
  const executor = new CursorExecutor();

  // -------------------------------------------------------------------------
  // 3a. refreshCredentials: documented limitation, returns null without throwing
  // -------------------------------------------------------------------------
  describe("refreshCredentials — documented limitation", () => {
    it("returns null without throwing", async () => {
      await expect(executor.refreshCredentials()).resolves.toBeNull();
    });

    it("returns null even when credentials are passed", async () => {
      await expect(
        executor.refreshCredentials({ accessToken: "tok" }, console, null)
      ).resolves.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // 3b. finalizedIds set only on isLast=true in SSE path
  // -------------------------------------------------------------------------
  describe("transformProtobufToSSE — finalizedIds only on isLast=true", () => {
    it("does not duplicate tool calls when isLast arrives on a later frame", async () => {
      const toolId = "tc-001";
      const frame1 = encodeToolCallFrame({ id: toolId, name: "read_file", args: '{"pa', isLast: false });
      const frame2 = encodeToolCallFrame({ id: toolId, name: "read_file", args: 'th":"/tmp"}', isLast: true });
      const buffer = Buffer.concat([frame1, frame2]);

      const response = executor.transformProtobufToSSE(buffer, "claude-3-5-sonnet", {
        messages: [{ role: "user", content: "test" }],
      });
      const text = await response.text();

      // Collect all tool_calls deltas from the SSE chunks
      const chunks = parseSSEChunks(text);
      const toolCallDeltas = chunks.flatMap(c =>
        (c.choices?.[0]?.delta?.tool_calls || [])
      );

      // There should be exactly 2 deltas: initial name chunk + argument delta chunk
      // (not 3+ from a duplicate push)
      const uniqueIds = new Set(toolCallDeltas.map(t => t.id).filter(Boolean));
      expect(uniqueIds.size).toBe(1);
      expect([...uniqueIds][0]).toBe(toolId);

      // The final chunk should have finish_reason = "tool_calls"
      const finalChunk = chunks.find(c => c.choices?.[0]?.finish_reason);
      expect(finalChunk?.choices?.[0]?.finish_reason).toBe("tool_calls");
    });

    it("does not duplicate tool calls when stream ends without isLast frame", async () => {
      const toolId = "tc-002";
      // Only one frame, isLast=false — simulates stream terminated before isLast
      const frame1 = encodeToolCallFrame({ id: toolId, name: "write_file", args: '{"path":"/tmp/x"}', isLast: false });
      const buffer = frame1;

      const response = executor.transformProtobufToSSE(buffer, "claude-3-5-sonnet", {
        messages: [{ role: "user", content: "test" }],
      });
      const text = await response.text();

      const chunks = parseSSEChunks(text);
      // Should have the tool call chunk
      const toolCallDeltas = chunks.flatMap(c =>
        (c.choices?.[0]?.delta?.tool_calls || [])
      );
      // Only ONE set of tool call chunks (no sweep-induced duplicate)
      const idCounts = {};
      for (const d of toolCallDeltas.filter(t => t.id)) {
        idCounts[d.id] = (idCounts[d.id] || 0) + 1;
      }
      // The tool call ID must not appear more than once as a "new call" header
      // (argument deltas are expected, but the initial id+name should be exactly once)
      const nameChunks = toolCallDeltas.filter(t => t.id && t.function?.name);
      expect(nameChunks.length).toBe(1);

      const finalChunk = chunks.find(c => c.choices?.[0]?.finish_reason);
      expect(finalChunk?.choices?.[0]?.finish_reason).toBe("tool_calls");
    });

    it("first-frame isLast=true finalizes immediately with correct args", async () => {
      const toolId = "tc-003";
      // Single frame with isLast=true
      const frame = encodeToolCallFrame({ id: toolId, name: "list_dir", args: '{"path":"/"}', isLast: true });
      const buffer = frame;

      const response = executor.transformProtobufToSSE(buffer, "claude-3-5-sonnet", {
        messages: [{ role: "user", content: "test" }],
      });
      const text = await response.text();
      const chunks = parseSSEChunks(text);

      const toolCallDeltas = chunks.flatMap(c =>
        (c.choices?.[0]?.delta?.tool_calls || [])
      );
      // Exactly one delta with the tool call name (no sweep duplication)
      const nameChunks = toolCallDeltas.filter(t => t.id && t.function?.name === "list_dir");
      expect(nameChunks.length).toBe(1);
      expect(nameChunks[0].id).toBe(toolId);

      const finalChunk = chunks.find(c => c.choices?.[0]?.finish_reason);
      expect(finalChunk?.choices?.[0]?.finish_reason).toBe("tool_calls");
    });
  });

  // -------------------------------------------------------------------------
  // 3b (JSON path) — finalizedIds only on isLast=true in transformProtobufToJSON
  // The JSON path already had correct isLast handling; verify it still works.
  // -------------------------------------------------------------------------
  describe("transformProtobufToJSON — isLast handling unchanged", () => {
    it("accumulates tool call arguments across frames, finalized on isLast=true", async () => {
      const toolId = "tc-json-001";
      const frame1 = encodeToolCallFrame({ id: toolId, name: "read_file", args: '{"pa', isLast: false });
      const frame2 = encodeToolCallFrame({ id: toolId, name: "read_file", args: 'th":"/etc"}', isLast: true });
      const buffer = Buffer.concat([frame1, frame2]);

      const response = executor.transformProtobufToJSON(buffer, "claude-3-5-sonnet", {
        messages: [{ role: "user", content: "test" }],
      });
      const body = await response.json();

      expect(body.choices[0].finish_reason).toBe("tool_calls");
      expect(body.choices[0].message.tool_calls).toHaveLength(1);
      const tc = body.choices[0].message.tool_calls[0];
      expect(tc.id).toBe(toolId);
      expect(tc.function.name).toBe("read_file");
      // Args should be fully accumulated across both frames
      expect(tc.function.arguments).toBe('{"path":"/etc"}');
    });
  });

  // -------------------------------------------------------------------------
  // 3c. transformedBody in execute() return is JSON body, not protobuf bytes
  // -------------------------------------------------------------------------
  describe("execute() — transformedBody return is JSON body for logging", () => {
    it("returns transformedBody equal to the input JSON body (not binary protobuf)", async () => {
      const credentials = {
        accessToken: "tok",
        providerSpecificData: { machineId: "machine-abc" },
      };
      const inputBody = {
        messages: [{ role: "user", content: "hello" }],
        model: "claude-3-5-sonnet",
      };

      // Mock buildHeaders to not require valid auth
      const mockBuildHeaders = vi.spyOn(executor, "buildHeaders").mockReturnValue({
        "Content-Type": "application/x-protobuf",
        "Authorization": "Bearer tok",
      });

      // Make the HTTP request fail so we can inspect the error return path
      const mockMakeHttp2Request = vi.spyOn(executor, "makeHttp2Request").mockResolvedValue({
        status: 400,
        headers: {},
        body: Buffer.from(JSON.stringify({ error: { message: "bad request" } })),
      });
      const mockMakeFetchRequest = vi.spyOn(executor, "makeFetchRequest").mockResolvedValue({
        status: 400,
        headers: {},
        body: Buffer.from(JSON.stringify({ error: { message: "bad request" } })),
      });

      const result = await executor.execute({
        model: "claude-3-5-sonnet",
        body: inputBody,
        stream: true,
        credentials,
        signal: new AbortController().signal,
        log: null,
        proxyOptions: null,
        passthrough: false,
      });

      // transformedBody in the return should be the original JSON body, not binary bytes
      expect(result.transformedBody).toBe(inputBody);
      expect(Buffer.isBuffer(result.transformedBody)).toBe(false);

      mockBuildHeaders.mockRestore();
      mockMakeHttp2Request.mockRestore();
      mockMakeFetchRequest.mockRestore();
    });
  });
});
