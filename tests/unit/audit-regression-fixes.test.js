import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
  trackPendingRequest: vi.fn(),
}));

vi.mock("open-sse/handlers/chatCore/requestDetail.js", () => ({
  buildRequestDetail: vi.fn((base, overrides) => ({ ...base, ...overrides })),
  extractRequestConfig: vi.fn(() => ({})),
  saveUsageStats: vi.fn(),
}));

const { handleForcedSSEToJson } = await import("../../open-sse/handlers/chatCore/sseToJsonHandler.js");
const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { formatSSE } = await import("../../open-sse/utils/streamHelpers.js");
const { convertResponsesStreamToJson } = await import("../../open-sse/transformer/streamToJsonConverter.js");
const { resolveConnectionProxyUrl } = await import("../../open-sse/utils/proxyFetch.js");
const { OpenCodeGoExecutor } = await import("../../open-sse/executors/opencode-go.js");
const { usesAnthropicToolCleaning } = await import("../../open-sse/translator/helpers/claudeHelper.js");

const root = join(import.meta.dirname, "..", "..");

function baseForcedSseOptions(overrides = {}) {
  return {
    provider: "openai",
    model: "gpt-4o",
    body: { messages: [{ role: "user", content: "hi" }] },
    stream: true,
    translatedBody: { messages: [{ role: "user", content: "hi" }] },
    finalBody: null,
    requestStartTime: Date.now(),
    connectionId: "conn-1",
    apiKey: "key-1",
    clientRawRequest: { endpoint: "/v1/chat/completions" },
    onRequestSuccess: vi.fn(),
    trackDone: vi.fn(),
    appendLog: vi.fn(() => Promise.resolve()),
    passthrough: false,
    ...overrides,
  };
}

describe("audit regression fixes — forced SSE response shapes", () => {
  it("returns Claude JSON for non-streaming Claude clients on standard OpenAI SSE", async () => {
    const sse = [
      'data: {"id":"chatcmpl-1","model":"gpt-4o","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}',
      'data: {"id":"chatcmpl-1","model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}',
      "data: [DONE]",
      "",
    ].join("\n");

    const result = await handleForcedSSEToJson(baseForcedSseOptions({
      providerResponse: new Response(sse, { headers: { "content-type": "text/event-stream" } }),
      sourceFormat: FORMATS.CLAUDE,
      targetFormat: FORMATS.OPENAI,
    }));

    expect(result.success).toBe(true);
    const body = await result.response.json();
    expect(body.type).toBe("message");
    expect(body.content).toEqual([{ type: "text", text: "hello" }]);
    expect(body.usage).toEqual({ input_tokens: 2, output_tokens: 1 });
  });

  it("returns Claude JSON for non-streaming Claude clients on Responses API SSE", async () => {
    const sse = [
      'event: response.output_item.done\ndata: {"output_index":0,"item":{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]}}',
      'event: response.completed\ndata: {"response":{"id":"resp_1","created_at":1700000000,"status":"completed","model":"gpt-5","usage":{"input_tokens":2,"output_tokens":1,"total_tokens":3}}}',
      "",
    ].join("\n\n");

    const result = await handleForcedSSEToJson(baseForcedSseOptions({
      provider: "codex",
      providerResponse: new Response(sse, { headers: { "content-type": "text/event-stream" } }),
      sourceFormat: FORMATS.CLAUDE,
      targetFormat: FORMATS.OPENAI_RESPONSES,
      translatedBody: { input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }] },
    }));

    expect(result.success).toBe(true);
    const body = await result.response.json();
    expect(body.type).toBe("message");
    expect(body.content).toEqual([{ type: "text", text: "hello" }]);
    expect(body.usage).toEqual({ input_tokens: 2, output_tokens: 1 });
  });

  it("fails closed on malformed Responses API function-call arguments for Gemini", async () => {
    const sse = [
      'event: response.output_item.done\ndata: {"output_index":0,"item":{"id":"call_1","type":"function_call","call_id":"call_1","name":"tool","arguments":"{"}}}',
      'event: response.completed\ndata: {"response":{"id":"resp_1","status":"completed","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
      "",
    ].join("\n\n");

    const result = await handleForcedSSEToJson(baseForcedSseOptions({
      provider: "codex",
      providerResponse: new Response(sse, { headers: { "content-type": "text/event-stream" } }),
      sourceFormat: FORMATS.GEMINI,
      targetFormat: FORMATS.OPENAI_RESPONSES,
      translatedBody: { input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }] },
    }));

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
  });
});

describe("audit regression fixes — streaming helpers", () => {
  it("formats OpenAI Responses SSE with native event lines", () => {
    expect(formatSSE({ event: "response.created", data: { response: { id: "resp_1" } } }, FORMATS.OPENAI_RESPONSES))
      .toBe('event: response.created\ndata: {"response":{"id":"resp_1"}}\n\n');
  });

  it("parses CRLF-delimited Responses API SSE", async () => {
    const sse = [
      'event: response.output_item.done\r\ndata: {"output_index":0,"item":{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]}}',
      'event: response.completed\r\ndata: {"response":{"id":"resp_1","status":"completed","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
      "",
    ].join("\r\n\r\n");
    const json = await convertResponsesStreamToJson(new Response(sse).body);
    expect(json.status).toBe("completed");
    expect(json.output[0].content[0].text).toBe("hello");
  });
});

describe("audit regression fixes — proxy and executor state", () => {
  it("invalid configured connection proxy fails closed by default", () => {
    expect(() => resolveConnectionProxyUrl("https://api.example.com/v1", {
      connectionProxyEnabled: true,
      connectionProxyUrl: "ftp://proxy.example.com:21",
    })).toThrow(/Strict connection proxy URL is invalid/);
  });

  it("invalid configured connection proxy can fail open only when strictProxy=false", () => {
    expect(resolveConnectionProxyUrl("https://api.example.com/v1", {
      connectionProxyEnabled: true,
      connectionProxyUrl: "ftp://proxy.example.com:21",
      strictProxy: false,
    })).toBeNull();
  });

  it("translator send passes per-connection proxy options into executor", () => {
    const src = readFileSync(join(root, "src/app/api/translator/send/route.js"), "utf8");
    expect(src).toContain("buildProxyOptionsFromCredentials(credentials)");
    expect(src).toMatch(/const execOpts = \{[\s\S]*proxyOptions,/);
  });

  it("OpenCode Go headers use request model, not prior singleton state", () => {
    const executor = new OpenCodeGoExecutor();
    executor.buildUrl("gpt-4o");
    const headers = executor.buildHeaders({ apiKey: "key" }, false, "minimax-m2.5");
    expect(headers["x-api-key"]).toBe("key");
    expect(headers.Authorization).toBeUndefined();
  });

  it("singleton executors no longer store request-local header state", () => {
    expect(readFileSync(join(root, "open-sse/executors/opencode-go.js"), "utf8")).not.toMatch(/_lastModel/);
    expect(readFileSync(join(root, "open-sse/executors/gemini-cli.js"), "utf8")).not.toMatch(/_currentModel/);
    expect(readFileSync(join(root, "open-sse/executors/codex.js"), "utf8")).not.toMatch(/_currentSessionId/);
  });
});

describe("audit regression fixes — tool cleaning", () => {
  it("does not apply Anthropic tool cleaning to OpenAI/Gemini target schemas", () => {
    expect(usesAnthropicToolCleaning("openai", true)).toBe(false);
    expect(usesAnthropicToolCleaning("gemini", true)).toBe(false);
    expect(usesAnthropicToolCleaning("gemini-cli", true)).toBe(false);
    expect(usesAnthropicToolCleaning("antigravity", true)).toBe(false);
  });
});
