/**
 * Tests for passthrough response preservation (Task 2.4)
 *
 * Validates:
 * - Preserve upstream response shape (no field stripping or injection)
 * - Preserve upstream error shape where safe
 * - Preserve streaming behavior if the client requested streaming
 * - Preserve provider-specific response fields
 * - Do NOT convert to another provider schema unless the endpoint contract explicitly requires it
 *
 * Requirements: 1.2, 1.5
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ===================================================================
// Non-streaming response preservation tests
// ===================================================================

vi.mock("open-sse/translator/formats.js", () => ({
  FORMATS: { CLAUDE: "claude", OPENAI: "openai", GEMINI: "gemini", GEMINI_CLI: "gemini-cli", ANTIGRAVITY: "antigravity", OPENAI_RESPONSES: "openai-responses" },
}));

vi.mock("open-sse/translator/index.js", () => ({
  needsTranslation: vi.fn((target, source) => target !== source),
}));

vi.mock("open-sse/translator/response/ollama-to-openai.js", () => ({
  ollamaBodyToOpenAI: vi.fn((body) => body),
}));

vi.mock("open-sse/utils/usageTracking.js", () => ({
  addBufferToUsage: (u) => u,
  filterUsageForFormat: (u) => u,
}));

vi.mock("open-sse/utils/error.js", () => ({
  createErrorResult: (status, msg) => ({ success: false, status, error: msg, response: new Response(JSON.stringify({ error: { message: msg } }), { status }) }),
  HTTP_STATUS: { BAD_GATEWAY: 502 },
}));

vi.mock("open-sse/config/runtimeConfig.js", () => ({
  HTTP_STATUS: { BAD_REQUEST: 400, BAD_GATEWAY: 502 },
  MEMORY_CONFIG: { sessionTtlMs: 7200000, sessionCleanupIntervalMs: 1800000 },
}));

vi.mock("open-sse/handlers/chatCore/sseToJsonHandler.js", () => ({
  parseSSEToOpenAIResponse: vi.fn(),
}));

vi.mock("open-sse/handlers/chatCore/requestDetail.js", () => ({
  buildRequestDetail: () => ({}),
  extractRequestConfig: () => ({}),
  extractUsageFromResponse: (body) => body?.usage || { prompt_tokens: 0, completion_tokens: 0 },
  saveUsageStats: vi.fn(),
}));

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
}));

vi.mock("open-sse/utils/claudeCloaking.js", () => ({
  decloakToolNames: (body) => body,
}));

const { handleNonStreamingResponse } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");

function makeResponseOptions(responseBody, overrides = {}) {
  return {
    providerResponse: {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Map([["content-type", "application/json"]]),
      json: () => Promise.resolve(responseBody),
      text: () => Promise.resolve(JSON.stringify(responseBody)),
    },
    provider: "claude",
    model: "claude-sonnet-4-20250514",
    sourceFormat: "claude",
    targetFormat: "claude",
    body: { messages: [{ role: "user", content: "Hello" }] },
    stream: false,
    translatedBody: { messages: [{ role: "user", content: "Hello" }], model: "claude-sonnet-4-20250514" },
    finalBody: null,
    requestStartTime: Date.now(),
    connectionId: "conn-1",
    apiKey: "test-key",
    clientRawRequest: { headers: {}, body: "{}", endpoint: "/v1/messages" },
    onRequestSuccess: vi.fn(),
    reqLogger: {
      logProviderResponse: vi.fn(),
      logConvertedResponse: vi.fn(),
    },
    toolNameMap: null,
    trackDone: vi.fn(),
    appendLog: vi.fn(),
    passthrough: true,
    ...overrides,
  };
}

describe("Passthrough response preservation — non-streaming (Task 2.4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preserves Claude-native response shape without modification", async () => {
    const claudeResponse = {
      id: "msg_01XFDUDYJgAACzvnptvVoYEL",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-20250514",
      content: [{ type: "text", text: "Hello! How can I help you?" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 25, output_tokens: 12 },
    };

    const result = await handleNonStreamingResponse(makeResponseOptions(claudeResponse));

    expect(result.success).toBe(true);
    const body = await result.response.json();

    // Verify response shape is preserved exactly
    expect(body.id).toBe("msg_01XFDUDYJgAACzvnptvVoYEL");
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(body.stop_reason).toBe("end_turn");
    expect(body.stop_sequence).toBeNull();
    expect(body.content).toEqual([{ type: "text", text: "Hello! How can I help you?" }]);
    expect(body.usage).toEqual({ input_tokens: 25, output_tokens: 12 });
  });

  it("does NOT inject OpenAI-required fields (object, created) in passthrough mode", async () => {
    const claudeResponse = {
      id: "msg_test",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Hi" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    };

    const result = await handleNonStreamingResponse(makeResponseOptions(claudeResponse));
    const body = await result.response.json();

    // These OpenAI-specific fields should NOT be injected in passthrough mode
    expect(body.object).toBeUndefined();
    expect(body.created).toBeUndefined();
    // Claude-native fields should remain
    expect(body.type).toBe("message");
    expect(body.stop_reason).toBe("end_turn");
  });

  it("preserves provider-specific fields (thinking, tool_use) in passthrough mode", async () => {
    const claudeResponse = {
      id: "msg_thinking",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-20250514",
      content: [
        { type: "thinking", thinking: "Let me analyze this..." },
        { type: "text", text: "Here is my answer." },
        { type: "tool_use", id: "toolu_123", name: "bash", input: { command: "ls" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20 },
    };

    const result = await handleNonStreamingResponse(makeResponseOptions(claudeResponse));
    const body = await result.response.json();

    // All provider-specific content blocks preserved
    expect(body.content).toHaveLength(3);
    expect(body.content[0].type).toBe("thinking");
    expect(body.content[0].thinking).toBe("Let me analyze this...");
    expect(body.content[1].type).toBe("text");
    expect(body.content[2].type).toBe("tool_use");
    expect(body.content[2].name).toBe("bash");
    // Provider-specific usage fields preserved
    expect(body.usage.cache_read_input_tokens).toBe(20);
  });

  it("does NOT strip reasoning_content in passthrough mode (OpenAI-native response)", async () => {
    const openaiResponse = {
      id: "chatcmpl-abc123",
      object: "chat.completion",
      created: 1700000000,
      model: "o1-preview",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: "The answer is 42.",
          reasoning_content: "Let me think step by step..."
        },
        finish_reason: "stop"
      }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    };

    const result = await handleNonStreamingResponse(makeResponseOptions(openaiResponse, {
      provider: "openai",
      sourceFormat: "openai",
      targetFormat: "openai",
    }));
    const body = await result.response.json();

    // reasoning_content should be preserved in passthrough mode
    expect(body.choices[0].message.reasoning_content).toBe("Let me think step by step...");
  });

  it("does NOT strip Azure-specific fields in passthrough mode", async () => {
    const azureResponse = {
      id: "chatcmpl-azure123",
      object: "chat.completion",
      created: 1700000000,
      model: "gpt-4",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "Hello" },
        finish_reason: "stop",
        content_filter_results: { hate: { filtered: false } },
      }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      prompt_filter_results: [{ content_filter_results: { hate: { filtered: false } } }],
    };

    const result = await handleNonStreamingResponse(makeResponseOptions(azureResponse, {
      provider: "openai",
      sourceFormat: "openai",
      targetFormat: "openai",
    }));
    const body = await result.response.json();

    // Azure-specific fields should be preserved in passthrough
    expect(body.prompt_filter_results).toBeDefined();
    expect(body.choices[0].content_filter_results).toBeDefined();
  });

  it("does NOT modify finish_reason in passthrough mode", async () => {
    // Some providers return non-standard finish_reason values
    const response = {
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 1700000000,
      model: "gpt-4",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "test", arguments: "{}" } }]
        },
        finish_reason: "other"  // Non-standard value
      }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    };

    const result = await handleNonStreamingResponse(makeResponseOptions(response, {
      provider: "openai",
      sourceFormat: "openai",
      targetFormat: "openai",
    }));
    const body = await result.response.json();

    // Non-standard finish_reason should be preserved as-is in passthrough
    expect(body.choices[0].finish_reason).toBe("other");
  });

  it("does NOT filter/modify usage fields in passthrough mode", async () => {
    const response = {
      id: "chatcmpl-usage",
      object: "chat.completion",
      created: 1700000000,
      model: "gpt-4",
      choices: [{ index: 0, message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        prompt_tokens_details: { cached_tokens: 80 },
        completion_tokens_details: { reasoning_tokens: 30 },
      },
    };

    const result = await handleNonStreamingResponse(makeResponseOptions(response, {
      provider: "openai",
      sourceFormat: "openai",
      targetFormat: "openai",
    }));
    const body = await result.response.json();

    // All usage fields preserved without buffer addition or format filtering
    expect(body.usage.prompt_tokens).toBe(100);
    expect(body.usage.completion_tokens).toBe(50);
    expect(body.usage.total_tokens).toBe(150);
    expect(body.usage.prompt_tokens_details).toEqual({ cached_tokens: 80 });
    expect(body.usage.completion_tokens_details).toEqual({ reasoning_tokens: 30 });
  });

  it("preserves unknown/custom provider fields in passthrough mode", async () => {
    const response = {
      id: "msg_custom",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Hello" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
      // Custom provider-specific fields that should be preserved
      custom_metadata: { latency_ms: 150, region: "us-east-1" },
      server_timing: "model=sonnet;dur=120",
    };

    const result = await handleNonStreamingResponse(makeResponseOptions(response));
    const body = await result.response.json();

    // Custom/unknown fields should be preserved
    expect(body.custom_metadata).toEqual({ latency_ms: 150, region: "us-east-1" });
    expect(body.server_timing).toBe("model=sonnet;dur=120");
  });

  it("in non-passthrough mode, DOES apply response mutations (object, created injection)", async () => {
    const response = {
      id: "chatcmpl-test",
      model: "gpt-4",
      choices: [{ index: 0, message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    };

    const result = await handleNonStreamingResponse(makeResponseOptions(response, {
      passthrough: false,
      sourceFormat: "openai",
      targetFormat: "openai",
      provider: "openai",
    }));
    const body = await result.response.json();

    // In non-passthrough mode, OpenAI-required fields ARE injected
    expect(body.object).toBe("chat.completion");
    expect(body.created).toBeDefined();
  });
});
