/**
 * nonStreamingHandler — fail-closed invalid tool-call JSON (mirrors sseToJsonHandler).
 */
import { describe, it, expect, vi } from "vitest";

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
  extractUsageFromResponse: vi.fn(() => ({ prompt_tokens: 1, completion_tokens: 1 })),
}));

import { translateNonStreamingResponse, handleNonStreamingResponse } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { HTTP_STATUS } from "../../open-sse/config/runtimeConfig.js";
import { PROXY_INTERNAL_ERROR_CODES } from "../../open-sse/utils/error.js";

function openaiWithToolCalls(args, name = "get_weather") {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1700000000,
    model: "gpt-4",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_123",
          type: "function",
          function: { name, arguments: args },
        }],
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

describe("nonStreamingHandler — invalid tool-call JSON fail-closed", () => {
  it("returns null for truncated tool arguments when translating OpenAI → Claude", () => {
    const result = translateNonStreamingResponse(
      openaiWithToolCalls('{"city":'),
      FORMATS.OPENAI,
      FORMATS.CLAUDE
    );
    expect(result).toBeNull();
  });

  it("returns null for truncated tool arguments when translating OpenAI → Gemini", () => {
    const result = translateNonStreamingResponse(
      openaiWithToolCalls('{"city":'),
      FORMATS.OPENAI,
      FORMATS.GEMINI
    );
    expect(result).toBeNull();
  });

  it("returns null for truncated tool arguments when translating OpenAI → Antigravity", () => {
    const result = translateNonStreamingResponse(
      openaiWithToolCalls('{"city":'),
      FORMATS.OPENAI,
      FORMATS.ANTIGRAVITY
    );
    expect(result).toBeNull();
  });

  it("preserves valid tool-call arguments for Claude source format", () => {
    const result = translateNonStreamingResponse(
      openaiWithToolCalls(JSON.stringify({ city: "NYC" })),
      FORMATS.OPENAI,
      FORMATS.CLAUDE
    );
    const toolBlock = result.content.find((b) => b.type === "tool_use");
    expect(toolBlock.name).toBe("get_weather");
    expect(toolBlock.input).toEqual({ city: "NYC" });
    expect(result.stop_reason).toBe("tool_use");
  });

  it("preserves valid tool-call arguments for Gemini source format", () => {
    const result = translateNonStreamingResponse(
      openaiWithToolCalls(JSON.stringify({ city: "NYC" })),
      FORMATS.OPENAI,
      FORMATS.GEMINI
    );
    const funcPart = result.candidates[0].content.parts.find((p) => p.functionCall);
    expect(funcPart.functionCall.name).toBe("get_weather");
    expect(funcPart.functionCall.args).toEqual({ city: "NYC" });
  });

  it("treats missing/empty tool arguments as no-argument call", () => {
    const noArgs = openaiWithToolCalls(undefined);
    noArgs.choices[0].message.tool_calls[0].function.arguments = "";

    const claude = translateNonStreamingResponse(noArgs, FORMATS.OPENAI, FORMATS.CLAUDE);
    const toolBlock = claude.content.find((b) => b.type === "tool_use");
    expect(toolBlock.input).toEqual({});

    const gemini = translateNonStreamingResponse(noArgs, FORMATS.OPENAI, FORMATS.GEMINI);
    const funcPart = gemini.candidates[0].content.parts.find((p) => p.functionCall);
    expect(funcPart.functionCall.args).toEqual({});
  });

  it("handleNonStreamingResponse returns 502 when translation fails on invalid tool JSON", async () => {
    const providerResponse = new Response(
      JSON.stringify(openaiWithToolCalls('{"broken":')),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

    const appendLog = vi.fn();
    const mockReqLogger = {
      logClientRawRequest: vi.fn(),
      logRawRequest: vi.fn(),
      logTargetRequest: vi.fn(),
      logProviderResponse: vi.fn(),
      logConvertedResponse: vi.fn(),
      logError: vi.fn(),
    };

    const result = await handleNonStreamingResponse({
      providerResponse,
      provider: "openai",
      model: "gpt-4",
      sourceFormat: FORMATS.CLAUDE,
      targetFormat: FORMATS.OPENAI,
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      translatedBody: null,
      finalBody: null,
      requestStartTime: Date.now(),
      connectionId: "conn-1",
      apiKey: "key",
      clientRawRequest: null,
      onRequestSuccess: null,
      reqLogger: mockReqLogger,
      toolNameMap: null,
      trackDone: vi.fn(),
      appendLog,
      passthrough: false,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(HTTP_STATUS.BAD_GATEWAY);
    expect(result.errorCode).toBe(PROXY_INTERNAL_ERROR_CODES.RESPONSE_PARSE_FAILED);
    expect(appendLog).toHaveBeenCalledWith({ status: `FAILED ${HTTP_STATUS.BAD_GATEWAY}` });
  });
});
