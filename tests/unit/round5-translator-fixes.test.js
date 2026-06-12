/**
 * Round 5 — translator / assembly behavioral fixes
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { geminiToOpenAIResponse } from "../../open-sse/translator/response/gemini-to-openai.js";
import { geminiToOpenAIRequest } from "../../open-sse/translator/request/gemini-to-openai.js";
import { buildCursorRequest } from "../../open-sse/translator/request/openai-to-cursor.js";
import { openaiToGeminiRequest } from "../../open-sse/translator/request/openai-to-gemini.js";
import { detectFormat } from "../../open-sse/services/provider.js";
import {
  parseSSEToGeminiResponse,
  handleForcedSSEToJson,
} from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
  saveRequestUsage: vi.fn(() => Promise.resolve()),
}));

vi.mock("open-sse/handlers/chatCore/requestDetail.js", () => ({
  buildRequestDetail: vi.fn(() => ({})),
  extractRequestConfig: vi.fn(() => ({})),
  saveUsageStats: vi.fn(),
  extractUsageFromResponse: vi.fn(() => ({})),
}));

const root = join(import.meta.dirname, "..", "..");

describe("gemini-to-openai response — thought parts", () => {
  it("maps part.thought text to reasoning_content without thoughtSignature", () => {
    const state = { toolCalls: new Map(), functionIndex: 0 };
    const chunks = geminiToOpenAIResponse({
      candidates: [{
        content: { parts: [{ thought: true, text: "internal reasoning" }] },
        finishReason: "STOP",
      }],
    }, state);
    const textChunk = chunks.flat().find((c) => c.choices?.[0]?.delta?.reasoning_content);
    expect(textChunk?.choices?.[0]?.delta?.reasoning_content).toBe("internal reasoning");
    expect(textChunk?.choices?.[0]?.delta?.content).toBeUndefined();
  });
});

describe("gemini-to-openai request — mixed user turn and tool content", () => {
  it("keeps user text when functionResponse parts are present", () => {
    const out = geminiToOpenAIRequest("gemini-2.0", {
      contents: [{
        role: "user",
        parts: [
          { text: "context before tool" },
          { functionResponse: { id: "call_1", response: { result: "ok" } } },
        ],
      }],
    }, false);

    const userText = out.messages.find((m) => m.role === "user" && m.content === "context before tool");
    const toolMsg = out.messages.find((m) => m.role === "tool");
    expect(userText).toBeTruthy();
    expect(toolMsg?.tool_call_id).toBe("call_1");
  });

  it("does not double JSON.stringify string functionResponse results", () => {
    const out = geminiToOpenAIRequest("gemini-2.0", {
      contents: [{
        role: "user",
        parts: [{ functionResponse: { id: "c1", response: { result: "plain-text" } } }],
      }],
    }, false);
    const toolMsg = out.messages.find((m) => m.role === "tool");
    expect(toolMsg.content).toBe("plain-text");
  });

  it("maps model thought parts to reasoning_content on assistant messages", () => {
    const out = geminiToOpenAIRequest("gemini-2.0", {
      contents: [{
        role: "model",
        parts: [
          { thought: true, text: "thinking" },
          { text: "answer" },
        ],
      }],
    }, false);
    const assistant = out.messages.find((m) => m.role === "assistant");
    expect(assistant.reasoning_content).toBe("thinking");
    expect(assistant.content).toBe("answer");
  });
});

describe("mergeGeminiParts — functionCall dedupe", () => {
  it("dedupes repeated functionCall chunks by id during SSE assembly", () => {
    const sse = [
      'data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"id":"fc1","name":"lookup","args":{"q":"a"}}}]},"index":0}]}',
      'data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"id":"fc1","name":"lookup","args":{"q":"a"}}}]},"finishReason":"STOP","index":0}]}',
    ].join("\n");

    const parsed = parseSSEToGeminiResponse(sse, false);
    const fcParts = parsed.candidates[0].content.parts.filter((p) => p.functionCall);
    expect(fcParts).toHaveLength(1);
    expect(fcParts[0].functionCall.id).toBe("fc1");
  });
});

describe("handleForcedSSEToJson — Codex to Gemini functionCall parts", () => {
  function codexGeminiArgs(providerResponse) {
    return {
      providerResponse,
      sourceFormat: FORMATS.GEMINI,
      provider: "codex",
      model: "gemini-2.0-flash",
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

  it("includes functionCall parts from Responses API output", async () => {
    const sse = [
      'event: response.created\ndata: {"response":{"id":"resp_1","created_at":1700000000}}',
      'event: response.output_item.done\ndata: {"output_index":0,"item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Done"}]}}',
      'event: response.output_item.done\ndata: {"output_index":1,"item":{"type":"function_call","call_id":"call_1","name":"lookup","arguments":"{\\"q\\":\\"x\\"}"}}',
      'event: response.completed\ndata: {"response":{"usage":{"input_tokens":5,"output_tokens":3}}}',
    ].join("\n\n");

    const result = await handleForcedSSEToJson(codexGeminiArgs({
      headers: { "content-type": "text/event-stream" },
      body: new ReadableStream({
        start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); },
      }),
    }));

    expect(result.success).toBe(true);
    const body = await result.response.json();
    const parts = body.candidates[0].content.parts;
    expect(parts.some((p) => p.text === "Done")).toBe(true);
    const fc = parts.find((p) => p.functionCall);
    expect(fc.functionCall.name).toBe("lookup");
    expect(fc.functionCall.args).toEqual({ q: "x" });
  });
});

describe("openai-to-cursor — reasoning_content and images", () => {
  it("preserves reasoning_content on assistant messages", () => {
    const out = buildCursorRequest("composer", {
      messages: [{
        role: "assistant",
        content: "answer",
        reasoning_content: "chain of thought",
      }],
    }, false);
    expect(out.messages[0].reasoning_content).toBe("chain of thought");
    expect(out.messages[0].content).toBe("answer");
  });

  it("maps data URI image_url blocks to text placeholders", () => {
    const out = buildCursorRequest("composer", {
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "see this" },
          { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
        ],
      }],
    }, false);
    expect(out.messages[0].content).toContain("[Image attachment: image/png]");
    expect(out.messages[0].content).toContain("see this");
  });

  it("fails closed on remote image_url blocks", () => {
    expect(() => buildCursorRequest("composer", {
      messages: [{
        role: "user",
        content: [{ type: "image_url", image_url: { url: "https://example.com/x.png" } }],
      }],
    }, false)).toThrow(/remote image_url/);
  });
});

describe("detectFormat — body.user after Claude heuristics", () => {
  it("classifies Claude-shaped body with user field as claude when system is present", () => {
    const format = detectFormat({
      user: "uid-123",
      system: "You are helpful",
      messages: [{
        role: "user",
        content: [{ type: "text", text: "hi" }],
      }],
    });
    expect(format).toBe("claude");
  });

  it("still classifies OpenAI-only bodies with user field as openai", () => {
    const format = detectFormat({
      user: "uid-123",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(format).toBe("openai");
  });
});

describe("embeddingsCore and imageGenerationCore — copilotToken refresh gate", () => {
  it("embeddingsCore accepts copilotToken refresh results", () => {
    const src = readFileSync(join(root, "open-sse/handlers/embeddingsCore.js"), "utf8");
    expect(src).toMatch(/newCredentials\?\.accessToken \|\| newCredentials\?\.copilotToken \|\| newCredentials\?\.apiKey/);
  });

  it("imageGenerationCore accepts copilotToken refresh results", () => {
    const src = readFileSync(join(root, "open-sse/handlers/imageGenerationCore.js"), "utf8");
    expect(src).toMatch(/newCredentials\?\.accessToken \|\| newCredentials\?\.copilotToken \|\| newCredentials\?\.apiKey/);
  });
});

describe("proxyFetch createBypassRequest — clone shim", () => {
  it("exposes clone() on bypass fetch responses", () => {
    const src = readFileSync(join(root, "open-sse/utils/proxyFetch.js"), "utf8");
    expect(src).toContain("clone: () => buildFetchResponse()");
  });
});

describe("openai-to-gemini — consistent sanitized tool names", () => {
  it("uses disambiguated names for functionCall and declarations", () => {
    const out = openaiToGeminiRequest("gemini-2.0", {
      messages: [{
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_a",
          type: "function",
          function: { name: "my-tool", arguments: "{}" },
        }],
      }],
      tools: [{
        type: "function",
        function: { name: "my-tool", description: "d", parameters: { type: "object", properties: {} } },
      }],
    }, false);

    const fcName = out.contents[0].parts.find((p) => p.functionCall)?.functionCall?.name;
    const declName = out.tools[0].functionDeclarations[0].name;
    expect(fcName).toBe(declName);
    expect(fcName).toMatch(/^[a-zA-Z_]/);
  });
});
