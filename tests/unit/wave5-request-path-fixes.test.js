/**
 * Wave 5 — request-path deep audit fixes (efe637a7) not covered by wave4 agents
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

const { geminiToOpenAIResponse } = await import("../../open-sse/translator/response/gemini-to-openai.js");
const { hasValidContent } = await import("../../open-sse/translator/helpers/claudeHelper.js");
const { openaiToClaudeRequest } = await import("../../open-sse/translator/request/openai-to-claude.js");
const { initState } = await import("../../open-sse/translator/index.js");
const { parseSSEToGeminiResponse } = await import("../../open-sse/handlers/chatCore/sseToJsonHandler.js");
const { handleForcedSSEToJson } = await import("../../open-sse/handlers/chatCore/sseToJsonHandler.js");
const { convertResponsesStreamToJson } = await import("../../open-sse/transformer/streamToJsonConverter.js");
const { handleComboChat, resetComboRotation } = await import("../../open-sse/services/combo.js");
const { hasAnthropicCacheBreakpoints } = await import("../../open-sse/rtk/cacheBoundary.js");
const { FORMATS } = await import("../../open-sse/translator/formats.js");

function sseStream(text) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

describe("wave5 — gemini-to-openai functionIndex double increment", () => {
  it("increments functionIndex once per functionCall part", () => {
    const state = {
      messageId: "m1",
      model: "gemini-2.5-pro",
      toolCalls: new Map(),
      functionIndex: 0,
    };
    const chunk = {
      candidates: [{
        content: {
          parts: [
            { functionCall: { name: "fn_a", args: { x: 1 } } },
            { functionCall: { name: "fn_b", args: { y: 2 } } },
          ],
        },
      }],
    };
    geminiToOpenAIResponse(chunk, state);
    expect(state.functionIndex).toBe(2);
    expect([...state.toolCalls.values()].map((t) => t.index)).toEqual([0, 1]);
  });
});

describe("wave5 — hasValidContent image and document", () => {
  it("accepts image blocks", () => {
    expect(hasValidContent({
      role: "user",
      content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } }],
    })).toBe(true);
  });

  it("accepts document blocks", () => {
    expect(hasValidContent({
      role: "user",
      content: [{ type: "document", source: { type: "text", data: "doc body" } }],
    })).toBe(true);
  });
});

describe("wave5 — openai-to-claude json_schema fallback", () => {
  it("adds JSON constraint when json_schema has no schema field", () => {
    const out = openaiToClaudeRequest("claude-sonnet-4-5", {
      messages: [{ role: "user", content: "hi" }],
      response_format: { type: "json_schema", json_schema: { name: "out" } },
    }, false);
    const systemText = out.system.map((b) => b.text).join("\n");
    expect(systemText).toContain("valid JSON");
    expect(systemText).not.toContain("JSON schema");
  });

  it("does not inject proxy cache_control for plain OpenAI clients", () => {
    const out = openaiToClaudeRequest("claude-sonnet-4-5", {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "search", parameters: { type: "object", properties: {} } } }],
    }, false);
    expect(hasAnthropicCacheBreakpoints(out)).toBe(false);
    expect(out.tools?.[0]?.cache_control).toBeUndefined();
  });

  it("injects marked proxy cache_control when client already owns cache", () => {
    const out = openaiToClaudeRequest("claude-sonnet-4-5", {
      messages: [{
        role: "user",
        content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }],
      }],
      tools: [{ type: "function", function: { name: "search", parameters: { type: "object", properties: {} } } }],
    }, false);
    expect(out.tools?.[out.tools.length - 1]?.cache_control?._proxyInjected).toBe(true);
  });
});

describe("wave5 — chatCore originalClientBody logging and cache check", () => {
  it("logs pristine body before mutations and checks cache on original", () => {
    const src = readFileSync(join(root, "open-sse/handlers/chatCore.js"), "utf8");
    expect(src).toMatch(/originalClientBody\s*=\s*structuredClone\(body\)/);
    expect(src).toMatch(/logRawRequest\(originalClientBody\)/);
    expect(src).toMatch(/hasAnthropicCacheBreakpoints\(originalClientBody\)/);
    expect(src).not.toMatch(/hasAnthropicCacheBreakpoints\(translatedBody\)/);
  });
});

describe("wave5 — responsesTransformer redacted_thinking global replace", () => {
  it("strips all opening redacted_thinking tags", () => {
    const src = readFileSync(join(root, "open-sse/transformer/responsesTransformer.js"), "utf8");
    expect(src).toMatch(/replace\(\/<think>\/g/);
  });
});

describe("wave5 — sseToJsonHandler onRequestSuccess timing", () => {
  it("calls onRequestSuccess immediately before successful return", async () => {
    const order = [];
    const onRequestSuccess = vi.fn(async () => { order.push("success"); });
    const appendLog = vi.fn(() => { order.push("appendLog"); });

    const sse = [
      'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}',
      "data: [DONE]",
      "",
    ].join("\n");

    const providerResponse = new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    await handleForcedSSEToJson({
      providerResponse,
      sourceFormat: FORMATS.OPENAI,
      provider: "openai",
      model: "gpt-4o",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      translatedBody: {},
      requestStartTime: Date.now(),
      onRequestSuccess,
      appendLog,
      trackDone: vi.fn(),
      passthrough: false,
    });

    expect(onRequestSuccess).toHaveBeenCalledTimes(1);
    expect(order.indexOf("success")).toBeGreaterThan(order.indexOf("appendLog"));
  });
});

describe("wave5 — combo rotation lock scope", () => {
  const mockLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    resetComboRotation();
  });

  it("runs handleSingleModel outside rotation lock", async () => {
    const models = ["cc/opus", "openai/gpt-4o"];
    let inFlight = 0;
    let maxConcurrent = 0;

    const handleSingleModel = vi.fn(async () => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 30));
      inFlight -= 1;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    await Promise.all([
      handleComboChat({
        body: { messages: [] },
        models,
        handleSingleModel,
        log: mockLog,
        comboName: "wave5-concurrent",
        comboStrategy: "round-robin",
        comboStickyLimit: 1,
      }),
      handleComboChat({
        body: { messages: [] },
        models,
        handleSingleModel,
        log: mockLog,
        comboName: "wave5-concurrent",
        comboStrategy: "round-robin",
        comboStickyLimit: 1,
      }),
    ]);

    expect(maxConcurrent).toBe(2);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
  });

  it("serializes rotation read via withComboRotationLock only", () => {
    const src = readFileSync(join(root, "open-sse/services/combo.js"), "utf8");
    expect(src).toMatch(/await withComboRotationLock\(comboName, async \(\) => \{[\s\S]*getRotatedModels/);
    expect(src).not.toMatch(/return withComboRotationLock\(comboName, async \(\) => \{[\s\S]*handleSingleModel/);
  });
});

describe("wave5 — initState toolCallIndex", () => {
  it("initializes toolCallIndex to 0", () => {
    expect(initState(FORMATS.OPENAI).toolCallIndex).toBe(0);
    expect(initState(FORMATS.CLAUDE).toolCallIndex).toBe(0);
  });
});

describe("wave5 — streamToJsonConverter output_item.done without item", () => {
  it("marks status failed when output_item.done has no item", async () => {
    const sse = [
      'event: response.output_item.done',
      "data: {\"output_index\":0}",
      "event: response.completed",
      'data: {"response":{"id":"r1","status":"completed"}}',
      "",
    ].join("\n");

    const json = await convertResponsesStreamToJson(sseStream(sse));
    expect(json.status).toBe("failed");
  });
});

describe("wave5 — parseSSEToGeminiResponse finishReason default", () => {
  it("defaults finishReason to STOP when stream saw [DONE]", () => {
    const sse = [
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"ok"}]}}]}',
      "data: [DONE]",
      "",
    ].join("\n");
    const parsed = parseSSEToGeminiResponse(sse, false);
    expect(parsed?.candidates?.[0]?.finishReason).toBe("STOP");
  });
});
