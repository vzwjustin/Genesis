/**
 * Tests for executor / translator bug fixes:
 *  1. cursor.js    — passthrough: require Buffer body; return raw bytes
 *  2. qwen.js      — refreshCredentials uses proxyAwareFetch with proxyOptions param
 *  3. kiro.js      — messageStopEvent before metering; stream=false JSON assembly
 *  4. antigravity  — fail on missing projectId; preserve client toolConfig/safetySettings
 *  5. openaiHelper — convert tool_use content blocks to tool_calls
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// 1. cursor.js passthrough fixes
// ─────────────────────────────────────────────────────────────────────────────
import { CursorExecutor } from "../../open-sse/executors/cursor.js";

describe("CursorExecutor — passthrough mode", () => {
  function makeMockHttp2(status, bodyBuffer) {
    return { status, headers: {}, body: bodyBuffer };
  }

  it("returns raw octet-stream response without protobuf transformation", async () => {
    const executor = new CursorExecutor();
    // Stub network to return a simple binary blob
    const fakeBody = Buffer.from("raw-protobuf-bytes");
    vi.spyOn(executor, "makeHttp2Request").mockResolvedValue(
      makeMockHttp2(200, fakeBody)
    );
    vi.spyOn(executor, "makeFetchRequest").mockResolvedValue(
      makeMockHttp2(200, fakeBody)
    );

    const credentials = {
      accessToken: "tok",
      providerSpecificData: { machineId: "mid-123" }
    };

    // Pass a Buffer body — it should go through as-is (no re-encoding)
    const result = await executor.execute({
      model: "cursor-small",
      body: fakeBody,
      stream: true,
      credentials,
      passthrough: true
    });

    expect(result.response.headers.get("content-type")).toBe("application/octet-stream");
    const buf = Buffer.from(await result.response.arrayBuffer());
    expect(buf).toEqual(fakeBody);
  });

  it("rejects a non-Buffer body in passthrough mode", async () => {
    const executor = new CursorExecutor();
    const credentials = {
      accessToken: "tok",
      providerSpecificData: { machineId: "mid-123" }
    };

    const jsonBody = { messages: [{ role: "user", content: "hi" }] };
    await expect(executor.execute({
      model: "cursor-small",
      body: jsonBody,
      stream: true,
      credentials,
      passthrough: true
    })).rejects.toThrow(/provider-native Buffer body/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. qwen.js refreshCredentials proxy fix
// ─────────────────────────────────────────────────────────────────────────────
import { QwenExecutor } from "../../open-sse/executors/qwen.js";
import * as proxyFetchModule from "../../open-sse/utils/proxyFetch.js";

describe("QwenExecutor — refreshCredentials uses proxyAwareFetch", () => {
  it("calls proxyAwareFetch with the provided proxyOptions", async () => {
    const executor = new QwenExecutor();
    const proxyOptions = { enabled: true, url: "http://proxy.local:8080" };

    // Stub proxyAwareFetch so we can capture the call
    const spy = vi.spyOn(proxyFetchModule, "proxyAwareFetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "new-token",
        refresh_token: "new-refresh",
        expires_in: 3600,
        resource_url: "https://shard.qwen.ai"
      })
    });

    const credentials = {
      refreshToken: "old-refresh",
      providerSpecificData: {}
    };

    const result = await executor.refreshCredentials(credentials, null, proxyOptions);

    expect(spy).toHaveBeenCalledOnce();
    // Third argument to proxyAwareFetch must be the proxyOptions object
    const [_url, _opts, passedProxy] = spy.mock.calls[0];
    expect(passedProxy).toBe(proxyOptions);

    expect(result.accessToken).toBe("new-token");
    expect(result.providerSpecificData?.resourceUrl).toBe("https://shard.qwen.ai");

    spy.mockRestore();
  });

  it("passes null proxyOptions when called without it (backward compat)", async () => {
    const executor = new QwenExecutor();

    const spy = vi.spyOn(proxyFetchModule, "proxyAwareFetch").mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "t", refresh_token: "r", expires_in: 0 })
    });

    await executor.refreshCredentials({ refreshToken: "r" }, null);

    const [_url, _opts, passedProxy] = spy.mock.calls[0];
    expect(passedProxy).toBeNull();

    spy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. kiro.js — messageStopEvent before metering + stream=false
// ─────────────────────────────────────────────────────────────────────────────
import { KiroExecutor } from "../../open-sse/executors/kiro.js";

/**
 * Build a minimal AWS EventStream frame with the given headers map and JSON payload.
 */
function buildKiroFrame(headers, payload) {
  const enc = new TextEncoder();
  const payloadBytes = enc.encode(JSON.stringify(payload));

  // Encode headers
  const headerParts = [];
  for (const [name, value] of Object.entries(headers)) {
    const nameBytes = enc.encode(name);
    const valueBytes = enc.encode(value);
    // name length (1 byte) + name + type (1 byte = 7 for string) + value length (2 bytes) + value
    const part = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
    let i = 0;
    part[i++] = nameBytes.length;
    part.set(nameBytes, i); i += nameBytes.length;
    part[i++] = 7; // string type
    part[i++] = (valueBytes.length >> 8) & 0xff;
    part[i++] = valueBytes.length & 0xff;
    part.set(valueBytes, i);
    headerParts.push(part);
  }
  const headersTotal = headerParts.reduce((n, p) => n + p.length, 0);
  const headersBytes = new Uint8Array(headersTotal);
  let off = 0;
  for (const p of headerParts) { headersBytes.set(p, off); off += p.length; }

  const totalLength = 12 + headersTotal + payloadBytes.length + 4; // prelude + headers + payload + crc
  const frame = new Uint8Array(totalLength);
  const view = new DataView(frame.buffer);
  view.setUint32(0, totalLength, false);   // total length
  view.setUint32(4, headersTotal, false);  // headers length
  view.setUint32(8, 0, false);             // prelude CRC (not validated)
  frame.set(headersBytes, 12);
  frame.set(payloadBytes, 12 + headersTotal);
  // message CRC (last 4 bytes) left as zeros — parseEventFrame doesn't validate CRC
  return frame;
}

function makeKiroStream(frames) {
  const total = frames.reduce((n, f) => n + f.length, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const f of frames) { buf.set(f, off); off += f.length; }
  return new ReadableStream({
    start(controller) { controller.enqueue(buf); controller.close(); }
  });
}

describe("KiroExecutor — messageStopEvent before metering", () => {
  it("emits usage chunk even when messageStopEvent precedes metering signals", async () => {
    const executor = new KiroExecutor();

    // Build stream where messageStopEvent arrives BEFORE meteringEvent + contextUsageEvent
    const frames = [
      buildKiroFrame({ ":event-type": "assistantResponseEvent" }, { content: "Hello" }),
      buildKiroFrame({ ":event-type": "messageStopEvent" }, {}),
      buildKiroFrame({ ":event-type": "metricsEvent" }, { metricsEvent: { inputTokens: 10, outputTokens: 3 } }),
    ];

    const fakeResponse = {
      status: 200,
      statusText: "OK",
      body: makeKiroStream(frames)
    };

    const sseResponse = executor.transformEventStreamToSSE(fakeResponse, "kiro-model");
    const text = await sseResponse.text();

    // The final SSE chunk carrying finish_reason must appear
    expect(text).toContain('"finish_reason"');
    expect(text).toContain("[DONE]");
  });
});

describe("KiroExecutor — truncated stream terminal semantics", () => {
  it("emits [DONE] without fabricating finish_reason when messageStopEvent is missing", async () => {
    const executor = new KiroExecutor();
    const frames = [
      buildKiroFrame({ ":event-type": "assistantResponseEvent" }, { content: "partial" }),
    ];
    const fakeResponse = {
      status: 200,
      statusText: "OK",
      body: makeKiroStream(frames),
    };

    const sseResponse = executor.transformEventStreamToSSE(fakeResponse, "kiro-model");
    const text = await sseResponse.text();

    expect(text).toContain("partial");
    expect(text).not.toMatch(/"finish_reason":"(stop|tool_calls)"/);
    expect(text).toContain("[DONE]");
  });
});

describe("KiroExecutor — stream=false assembles JSON", () => {
  it("returns a non-streaming JSON completion when stream=false", async () => {
    const executor = new KiroExecutor();
    const credentials = { accessToken: "tok" };

    const frames = [
      buildKiroFrame({ ":event-type": "assistantResponseEvent" }, { content: "Hi there" }),
      buildKiroFrame({ ":event-type": "messageStopEvent" }, {}),
      buildKiroFrame({ ":event-type": "metricsEvent" }, { metricsEvent: { inputTokens: 5, outputTokens: 2 } }),
    ];

    const fakeStream = makeKiroStream(frames);
    // status 200 → Response.ok is true automatically (read-only computed getter)
    const fakeUpstream = new Response(fakeStream, { status: 200 });

    vi.spyOn(proxyFetchModule, "proxyAwareFetch").mockResolvedValue(fakeUpstream);

    const result = await executor.execute({
      model: "kiro-model",
      body: { messages: [] },
      stream: false,
      credentials,
      signal: null
    });

    expect(result.response.headers.get("content-type")).toContain("application/json");
    const json = await result.response.json();
    expect(json.object).toBe("chat.completion");
    expect(json.choices[0].message.role).toBe("assistant");
    expect(json.choices[0].message.content).toContain("Hi there");
    expect(json.choices[0].finish_reason).toBe("stop");
    expect(json.usage).toBeDefined();

    vi.restoreAllMocks();
  });

  it("includes reasoning_content in non-streaming JSON when reasoning events arrive", async () => {
    const executor = new KiroExecutor();
    const credentials = { accessToken: "tok" };

    const frames = [
      buildKiroFrame({ ":event-type": "reasoningContentEvent" }, { text: "Let me think..." }),
      buildKiroFrame({ ":event-type": "assistantResponseEvent" }, { content: "Answer" }),
      buildKiroFrame({ ":event-type": "messageStopEvent" }, {}),
    ];

    const fakeStream = makeKiroStream(frames);
    const fakeUpstream = new Response(fakeStream, { status: 200 });

    vi.spyOn(proxyFetchModule, "proxyAwareFetch").mockResolvedValue(fakeUpstream);

    const result = await executor.execute({
      model: "kiro-model-thinking",
      body: { messages: [] },
      stream: false,
      credentials,
      signal: null
    });

    const json = await result.response.json();
    expect(json.choices[0].message.reasoning_content).toBe("Let me think...");
    expect(json.choices[0].message.content).toBe("Answer");

    vi.restoreAllMocks();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. antigravity.js — projectId enforcement + toolConfig/safetySettings
// ─────────────────────────────────────────────────────────────────────────────
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";

describe("AntigravityExecutor — projectId enforcement", () => {
  it("throws if credentials.projectId is missing", () => {
    const executor = new AntigravityExecutor();
    const body = { request: { contents: [], generationConfig: {} } };
    expect(() => executor.transformRequest("gemini-2.0-flash", body, true, {})).toThrow(
      /projectId is required/
    );
  });

  it("throws if credentials is null", () => {
    const executor = new AntigravityExecutor();
    expect(() => executor.transformRequest("gemini-2.0-flash", { request: {} }, true, null)).toThrow(
      /projectId is required/
    );
  });

  it("succeeds when projectId is present", () => {
    const executor = new AntigravityExecutor();
    const body = { request: { contents: [], generationConfig: {} } };
    expect(() =>
      executor.transformRequest("gemini-2.0-flash", body, true, { projectId: "my-proj" })
    ).not.toThrow();
  });
});

describe("AntigravityExecutor — preserve client toolConfig / safetySettings", () => {
  const executor = new AntigravityExecutor();
  const credentials = { projectId: "proj-abc" };

  it("preserves client safetySettings when provided", () => {
    const safetySettings = [{ category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_LOW_AND_ABOVE" }];
    const body = { request: { contents: [], generationConfig: {}, safetySettings } };
    const result = executor.transformRequest("m", body, true, credentials);
    expect(result.request.safetySettings).toEqual(safetySettings);
  });

  it("omits safetySettings when client does not send it", () => {
    const body = { request: { contents: [], generationConfig: {} } };
    const result = executor.transformRequest("m", body, true, credentials);
    expect(result.request.safetySettings).toBeUndefined();
  });

  it("preserves client toolConfig when no tools and client provides config", () => {
    const clientToolConfig = { functionCallingConfig: { mode: "NONE" } };
    const body = { request: { contents: [], generationConfig: {}, toolConfig: clientToolConfig } };
    const result = executor.transformRequest("m", body, true, credentials);
    // No tools → client toolConfig should be kept
    expect(result.request.toolConfig).toEqual(clientToolConfig);
  });

  it("overrides toolConfig with VALIDATED mode when tools are present", () => {
    const clientToolConfig = { functionCallingConfig: { mode: "NONE" } };
    const body = {
      request: {
        contents: [],
        generationConfig: {},
        toolConfig: clientToolConfig,
        tools: [{
          functionDeclarations: [{
            name: "my_tool",
            description: "A test tool",
            parameters: { type: "object", properties: {} }
          }]
        }]
      }
    };
    const result = executor.transformRequest("m", body, true, credentials);
    expect(result.request.toolConfig).toEqual({ functionCallingConfig: { mode: "VALIDATED" } });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. openaiHelper.js — tool_use → tool_calls conversion
// ─────────────────────────────────────────────────────────────────────────────
import { filterToOpenAIFormat } from "../../open-sse/translator/helpers/openaiHelper.js";

describe("filterToOpenAIFormat — tool_use → tool_calls conversion", () => {
  it("converts a single tool_use block to tool_calls", () => {
    const body = {
      messages: [{
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "toolu_abc123",
          name: "read_file",
          input: { path: "/tmp/foo.txt" }
        }]
      }]
    };
    const result = filterToOpenAIFormat(body);
    const msg = result.messages[0];
    expect(msg.tool_calls).toHaveLength(1);
    expect(msg.tool_calls[0].id).toBe("toolu_abc123");
    expect(msg.tool_calls[0].type).toBe("function");
    expect(msg.tool_calls[0].function.name).toBe("read_file");
    expect(JSON.parse(msg.tool_calls[0].function.arguments)).toEqual({ path: "/tmp/foo.txt" });
    expect(msg.content).toBeNull();
  });

  it("converts multiple tool_use blocks to multiple tool_calls", () => {
    const body = {
      messages: [{
        role: "assistant",
        content: [
          { type: "tool_use", id: "id1", name: "tool_a", input: { x: 1 } },
          { type: "tool_use", id: "id2", name: "tool_b", input: { y: 2 } }
        ]
      }]
    };
    const result = filterToOpenAIFormat(body);
    const msg = result.messages[0];
    expect(msg.tool_calls).toHaveLength(2);
    expect(msg.tool_calls[0].function.name).toBe("tool_a");
    expect(msg.tool_calls[1].function.name).toBe("tool_b");
  });

  it("preserves text content alongside tool_use blocks", () => {
    const body = {
      messages: [{
        role: "assistant",
        content: [
          { type: "text", text: "Let me check that file." },
          { type: "tool_use", id: "id1", name: "read_file", input: { path: "f.txt" } }
        ]
      }]
    };
    const result = filterToOpenAIFormat(body);
    const msg = result.messages[0];
    expect(msg.tool_calls).toHaveLength(1);
    // Content should contain the text (flattened to string when text-only)
    expect(msg.content).toContain("Let me check that file.");
  });

  it("handles string input in tool_use directly", () => {
    const body = {
      messages: [{
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "id1",
          name: "run_cmd",
          input: '{"command":"ls"}'
        }]
      }]
    };
    const result = filterToOpenAIFormat(body);
    const msg = result.messages[0];
    expect(msg.tool_calls[0].function.arguments).toBe('{"command":"ls"}');
  });

  it("keeps existing tool_calls messages untouched (no double conversion)", () => {
    const body = {
      messages: [{
        role: "assistant",
        content: null,
        tool_calls: [{ id: "existing", type: "function", function: { name: "foo", arguments: "{}" } }]
      }]
    };
    const result = filterToOpenAIFormat(body);
    const msg = result.messages[0];
    expect(msg.tool_calls).toHaveLength(1);
    expect(msg.tool_calls[0].id).toBe("existing");
  });

  it("does not drop messages converted from tool_use (filter step)", () => {
    const body = {
      messages: [{
        role: "assistant",
        content: [{ type: "tool_use", id: "id1", name: "noop", input: {} }]
      }]
    };
    const result = filterToOpenAIFormat(body);
    expect(result.messages).toHaveLength(1);
  });
});

describe("filterToOpenAIFormat — tool_result → role:tool hoisting", () => {
  it("hoists tool_result blocks to separate role:tool messages", () => {
    const body = {
      messages: [{
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "call_abc",
          content: "file contents here",
        }],
      }],
    };
    const result = filterToOpenAIFormat(body);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toEqual({
      role: "tool",
      tool_call_id: "call_abc",
      content: "file contents here",
    });
  });

  it("keeps trailing user text after hoisted tool_result blocks", () => {
    const body = {
      messages: [{
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "done" },
          { type: "text", text: "What next?" },
        ],
      }],
    };
    const result = filterToOpenAIFormat(body);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe("tool");
    expect(result.messages[0].tool_call_id).toBe("call_1");
    expect(result.messages[1]).toEqual({ role: "user", content: "What next?" });
  });
});
