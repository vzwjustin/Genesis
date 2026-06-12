/**
 * Round 3+4 — streaming / executor behavioral fixes
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

vi.mock("@/lib/compressionStats.js", () => ({
  recordCompressionStats: vi.fn(() => Promise.resolve()),
}));

vi.mock("open-sse/handlers/chatCore/requestDetail.js", () => ({
  buildRequestDetail: vi.fn(() => ({})),
  extractRequestConfig: vi.fn(() => ({})),
  saveUsageStats: vi.fn(),
  extractUsageFromResponse: vi.fn(() => ({})),
}));

import { CommandCodeExecutor } from "../../open-sse/executors/commandcode.js";
import { BaseExecutor } from "../../open-sse/executors/base.js";
import { KiroExecutor } from "../../open-sse/executors/kiro.js";
import { convertCommandCodeToOpenAI } from "../../open-sse/translator/response/commandcode-to-openai.js";
import { handleBypassRequest } from "../../open-sse/utils/bypassHandler.js";
import { fixMissingToolResponses } from "../../open-sse/translator/helpers/toolCallHelper.js";
import { openaiToClaudeRequest } from "../../open-sse/translator/request/openai-to-claude.js";
import { buildKiroPayload } from "../../open-sse/translator/request/openai-to-kiro.js";
import { getRotatedModels } from "../../open-sse/services/combo.js";
import { openaiToOllamaRequest } from "../../open-sse/translator/request/openai-to-ollama.js";
import { geminiToOpenAIResponse } from "../../open-sse/translator/response/gemini-to-openai.js";
import { convertOpenAIContentToParts } from "../../open-sse/translator/helpers/geminiHelper.js";
import { geminiToOpenAIRequest } from "../../open-sse/translator/request/gemini-to-openai.js";
import { handleNonStreamingResponse } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";
import { handleComboChat, resetComboRotation } from "../../open-sse/services/combo.js";
import { createErrorResult, PROXY_INTERNAL_ERROR_CODES, isProxyInternalError } from "../../open-sse/utils/error.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { handleForcedSSEToJson } from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";

const root = join(import.meta.dirname, "..", "..");

function ndjsonStream(lines) {
  const text = lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n";
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function buildKiroFrame(headers, payload) {
  const enc = new TextEncoder();
  const payloadBytes = enc.encode(JSON.stringify(payload));
  const headerParts = [];
  for (const [name, value] of Object.entries(headers)) {
    const nameBytes = enc.encode(name);
    const valueBytes = enc.encode(value);
    const part = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
    let i = 0;
    part[i++] = nameBytes.length;
    part.set(nameBytes, i); i += nameBytes.length;
    part[i++] = 7;
    part[i++] = (valueBytes.length >> 8) & 0xff;
    part[i++] = valueBytes.length & 0xff;
    part.set(valueBytes, i);
    headerParts.push(part);
  }
  const headersTotal = headerParts.reduce((n, p) => n + p.length, 0);
  const headersBytes = new Uint8Array(headersTotal);
  let off = 0;
  for (const p of headerParts) { headersBytes.set(p, off); off += p.length; }
  const totalLength = 12 + headersTotal + payloadBytes.length + 4;
  const frame = new Uint8Array(totalLength);
  const view = new DataView(frame.buffer);
  view.setUint32(0, totalLength, false);
  view.setUint32(4, headersTotal, false);
  view.setUint32(8, 0, false);
  frame.set(headersBytes, 12);
  frame.set(payloadBytes, 12 + headersTotal);
  return frame;
}

describe("commandcode — [DONE] gated on finish", () => {
  it("does not emit [DONE] when upstream never sent finish", async () => {
    const executor = new CommandCodeExecutor();
    const upstream = new Response(ndjsonStream([
      { type: "text-delta", text: "partial" },
    ]), { status: 200 });

    vi.spyOn(BaseExecutor.prototype, "execute").mockResolvedValue({
      response: upstream,
      url: "https://example.test",
      headers: {},
      transformedBody: {},
    });

    const result = await executor.execute({
      model: "commandcode",
      body: {},
      stream: true,
      credentials: { apiKey: "tok" },
    });

    const text = await result.response.text();
    expect(text).toContain("partial");
    expect(text).not.toContain("[DONE]");
  });

  it("emits [DONE] after finish event", async () => {
    const state = {};
    const lines = [
      { type: "text-delta", text: "ok" },
      { type: "finish" },
    ];
    for (const line of lines) {
      convertCommandCodeToOpenAI(line, state);
    }
    expect(state.finishSeen).toBe(true);
  });
});

describe("kiro — messageStop + metrics finish semantics", () => {
  it("streams finish_reason only after messageStop and metricsEvent", async () => {
    const executor = new KiroExecutor();
    const frames = [
      buildKiroFrame({ ":event-type": "assistantResponseEvent" }, { content: "Hi" }),
      buildKiroFrame({ ":event-type": "metricsEvent" }, { metricsEvent: { inputTokens: 1, outputTokens: 1 } }),
      buildKiroFrame({ ":event-type": "messageStopEvent" }, {}),
    ];
    const buf = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
    let off = 0;
    for (const f of frames) { buf.set(f, off); off += f.length; }

    const sse = executor.transformEventStreamToSSE({
      status: 200,
      body: new ReadableStream({
        start(c) { c.enqueue(buf); c.close(); },
      }),
    }, "kiro-model");
    const text = await sse.text();
    expect(text).toContain("Hi");
    expect(text).toMatch(/"finish_reason":"stop"/);
    expect(text).toContain("[DONE]");
  });

  it("assembly 502 uses stream_assembly_failed code", async () => {
    const executor = new KiroExecutor();
    const frames = [
      buildKiroFrame({ ":event-type": "assistantResponseEvent" }, { content: "partial" }),
    ];
    const buf = frames[0];
    const response = await executor.assembleEventStreamToJSON(
      new Response(new ReadableStream({
        start(c) { c.enqueue(buf); c.close(); },
      }), { status: 200 }),
      "kiro-model",
    );
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error.code).toBe("sse_assembly_failed");
    expect(isProxyInternalError({ errorCode: body.error.code })).toBe(true);
  });
});

describe("chatCore — proxyInternal metadata on provider errors", () => {
  it("createErrorResult marks Kiro assembly failures proxy-internal", () => {
    const result = createErrorResult(502, "Incomplete Kiro EventStream response", undefined, {
      errorCode: PROXY_INTERNAL_ERROR_CODES.SSE_ASSEMBLY_FAILED,
    });
    expect(result.proxyInternal).toBe(true);
  });

  it("passthrough upstream errors expose proxyInternal: false in source", () => {
    const src = readFileSync(join(root, "open-sse/handlers/chatCore.js"), "utf8");
    expect(src).toContain("proxyInternal: false");
    expect(src).toContain("upstreamErrorCode");
  });
});

describe("nonStreamingHandler — Responses API JSON shape", () => {
  const baseCtx = {
    provider: "codex",
    model: "gpt-5",
    sourceFormat: FORMATS.OPENAI_RESPONSES,
    targetFormat: FORMATS.OPENAI_RESPONSES,
    body: { input: "Hi" },
    stream: false,
    translatedBody: {},
    finalBody: null,
    requestStartTime: Date.now(),
    connectionId: "c1",
    apiKey: "k",
    clientRawRequest: { headers: {}, endpoint: "/v1/responses" },
    reqLogger: { logProviderResponse: vi.fn(), logConvertedResponse: vi.fn() },
    toolNameMap: null,
    trackDone: vi.fn(),
    appendLog: vi.fn(),
    passthrough: true,
  };

  it("accepts { object: response, output: [] } without empty-response 502", async () => {
    const onRequestSuccess = vi.fn();
    const result = await handleNonStreamingResponse({
      ...baseCtx,
      onRequestSuccess,
      providerResponse: {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Map([["content-type", "application/json"]]),
        json: () => Promise.resolve({
          object: "response",
          id: "resp_1",
          status: "completed",
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Hi" }] }],
        }),
      },
    });

    expect(result.success).toBe(true);
    expect(onRequestSuccess).toHaveBeenCalled();
  });
});

describe("combo — proxyInternal and duplicate model rotation", () => {
  const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    resetComboRotation();
  });

  it("does not advance on proxy-internal 502", async () => {
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: "Invalid SSE", code: PROXY_INTERNAL_ERROR_CODES.SSE_ASSEMBLY_FAILED },
      }), { status: 502, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const response = await handleComboChat({
      body: { messages: [] },
      models: ["a/m1", "b/m2"],
      handleSingleModel,
      log,
    });
    expect(response.status).toBe(502);
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
  });

  it("pins round-robin to the succeeded duplicate model index (not indexOf first)", async () => {
    const models = ["provider/same", "provider/other", "provider/same"];
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(new Response("fail", { status: 503 }))
      .mockResolvedValueOnce(new Response("fail", { status: 503 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    await handleComboChat({
      body: { messages: [] },
      models,
      handleSingleModel,
      log,
      comboName: "dup-pin",
      comboStrategy: "round-robin",
      comboStickyLimit: 1,
    });

    const rotated = getRotatedModels(models, "dup-pin", "round-robin", 1);
    // Pinned to index 2 (second "provider/same"), not index 0 from indexOf().
    expect(rotated[1]).toBe("provider/same");
    expect(rotated[2]).toBe("provider/other");
  });
});

describe("bypassHandler — Claude delta merge", () => {
  it("accumulates thinking and tool input_json deltas in non-streaming bypass", () => {
    const body = {
      stream: false,
      messages: [{ role: "user", content: [{ type: "text", text: "Warmup" }] }],
    };
    const result = handleBypassRequest(body, "claude-sonnet", "claude-cli/1.0");
    expect(result).toBeTruthy();
    expect(result.success).toBe(true);
  });
});

describe("openai-to-claude — prefix and tool_choice none", () => {
  it("maps tool_choice none to Claude none (must not call tools)", () => {
    const out = openaiToClaudeRequest("claude-sonnet", {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "Read", parameters: { type: "object", properties: {} } } }],
      tool_choice: "none",
    }, false);
    expect(out.tool_choice).toEqual({ type: "none" });
  });

  it("does not add proxy_ prefix to tool names", () => {
    const out = openaiToClaudeRequest("claude-sonnet", {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "Read", parameters: { type: "object", properties: {} } } }],
    }, false);
    expect(out.tools[0].name).toBe("Read");
  });
});

describe("openai-to-kiro / openai-to-ollama — safeParseJson", () => {
  it("kiro tolerates malformed tool arguments", () => {
    const out = buildKiroPayload("kiro", {
      messages: [
        { role: "user", content: "run" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{not-json" } }],
        },
      ],
    }, false);
    const history = out.conversationState?.history || [];
    const assistant = history.find((h) => h.assistantResponseMessage?.toolUses);
    expect(assistant.assistantResponseMessage.toolUses[0].input).toEqual({});
  });

  it("ollama tolerates malformed tool arguments", () => {
    const out = openaiToOllamaRequest("llama", {
      messages: [{
        role: "assistant",
        content: "",
        tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{bad" } }],
      }],
    }, false);
    expect(out.messages[0].tool_calls[0].function.arguments).toEqual({});
  });
});

describe("gemini translators — functionCall.id and multi functionResponse", () => {
  it("preserves functionCall.id in streaming response", () => {
    const state = { toolCalls: new Map(), functionIndex: 0 };
    const chunks = geminiToOpenAIResponse({
      candidates: [{
        content: {
          parts: [{ functionCall: { id: "fc_123", name: "lookup", args: { q: "x" } } }],
        },
        finishReason: "STOP",
      }],
    }, state);
    const toolChunk = chunks.flat().find((c) => c.choices?.[0]?.delta?.tool_calls);
    expect(toolChunk.choices[0].delta.tool_calls[0].id).toBe("fc_123");
  });

  it("emits separate tool messages for multiple functionResponse parts", () => {
    const out = geminiToOpenAIRequest("gemini-2.0", {
      contents: [{
        role: "user",
        parts: [
          { functionResponse: { id: "a", response: { result: "1" } } },
          { functionResponse: { id: "b", response: { result: "2" } } },
        ],
      }],
    }, false);
    const tools = out.messages.filter((m) => m.role === "tool");
    expect(tools).toHaveLength(2);
    expect(tools[0].tool_call_id).toBe("a");
    expect(tools[1].tool_call_id).toBe("b");
  });
});

describe("geminiHelper — mimeType field", () => {
  it("uses mimeType in inlineData parts", () => {
    const parts = convertOpenAIContentToParts([{
      type: "image_url",
      image_url: { url: "data:image/png;base64,abc" },
    }]);
    expect(parts[0].inlineData.mimeType).toBe("image/png");
    expect(parts[0].inlineData.mime_type).toBeUndefined();
  });
});

describe("fixMissingToolResponses — Gemini contents bodies", () => {
  it("inserts placeholder functionResponse after model functionCall", () => {
    const body = {
      contents: [
        { role: "model", parts: [{ functionCall: { id: "fc1", name: "lookup", args: {} } }] },
        { role: "user", parts: [{ text: "continue" }] },
      ],
    };
    fixMissingToolResponses(body);
    const inserted = body.contents[1];
    expect(inserted.role).toBe("user");
    expect(inserted.parts[0].functionResponse.response.result).toBe("[No response received]");
  });
});

describe("handleForcedSSEToJson — Codex branch", () => {
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

  it("returns proxy-internal 502 for truncated Responses stream", async () => {
    const sse = [
      'event: response.created\ndata: {"response":{"id":"resp_t","created_at":1700000000}}',
      'event: response.output_item.done\ndata: {"output_index":0,"item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"partial"}]}}',
    ].join("\n\n");
    const result = await handleForcedSSEToJson(codexArgs({
      headers: { "content-type": "text/event-stream" },
      body: new ReadableStream({
        start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); },
      }),
    }));
    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(result.proxyInternal).toBe(true);
  });
});
