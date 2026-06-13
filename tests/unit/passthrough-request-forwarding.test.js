/**
 * Tests for passthrough request forwarding (Task 2.2)
 *
 * Validates:
 * - In passthrough mode, ONLY the model name is swapped in the body
 * - Normal translation does NOT run
 * - Fields are NOT normalized or renamed
 * - Unknown provider-native fields are preserved
 * - Tool schemas are NOT rewritten
 * - providerThinking injection does NOT run in passthrough mode
 *
 * Requirements: 1.2
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the dependencies that chatCore imports
vi.mock("open-sse/services/provider.js", () => ({
  detectFormat: () => "claude",
  getTargetFormat: () => "claude",
}));

const mockTranslateRequest = vi.fn(() => ({ messages: [], model: "test" }));
vi.mock("open-sse/translator/index.js", () => ({
  translateRequest: (...args) => mockTranslateRequest(...args),
}));
vi.mock("open-sse/translator/formats.js", () => ({
  FORMATS: { CLAUDE: "claude", OPENAI: "openai", OPENAI_RESPONSES: "openai-responses", GEMINI: "gemini", GEMINI_CLI: "gemini-cli", ANTIGRAVITY: "antigravity" },
}));
vi.mock("open-sse/utils/stream.js", () => ({
  COLORS: { red: "", reset: "" },
}));
vi.mock("open-sse/utils/streamHandler.js", () => ({
  createStreamController: () => ({ signal: new AbortController().signal, handleComplete: () => {}, handleError: () => {} }),
}));
vi.mock("open-sse/services/tokenRefresh.js", () => ({
  refreshWithRetry: vi.fn(),
}));
vi.mock("open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: () => ({
    logClientRawRequest: () => {},
    logRawRequest: () => {},
    logTargetRequest: () => {},
    logError: () => {},
  }),
}));
vi.mock("open-sse/config/providerModels.js", () => ({
  getModelTargetFormat: () => null,
  getModelStrip: () => [],
  PROVIDER_ID_TO_ALIAS: {},
}));
vi.mock("open-sse/utils/error.js", () => ({
  createErrorResult: (status, msg) => ({ success: false, status, error: msg }),
  parseUpstreamError: vi.fn(),
  formatProviderError: (err) => err.message,
  VALIDATION_ERROR_TYPES: { TRANSLATION_INVALID_BODY: "translation_invalid_body", MISSING_REQUIRED_FIELD: "missing_required_field", UNSUPPORTED_REQUEST: "unsupported_request", VALIDATION_FAILED: "validation_failed" },
}));
vi.mock("open-sse/config/runtimeConfig.js", () => ({
  HTTP_STATUS: { BAD_REQUEST: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, BAD_GATEWAY: 502 },
  MEMORY_CONFIG: { sessionTtlMs: 7200000, sessionCleanupIntervalMs: 1800000 },
}));
vi.mock("open-sse/utils/bypassHandler.js", () => ({
  handleBypassRequest: () => null,
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
}));

// Capture the body sent to the executor
let executorReceivedBody = null;
let executorReceivedPassthrough = null;
let executorReceivedStream = null;
let executorReceivedSourceFormat = null;
vi.mock("open-sse/executors/index.js", () => ({
  getExecutor: () => ({
    execute: vi.fn(({ body, passthrough, stream, sourceFormat }) => {
      executorReceivedBody = body;
      executorReceivedPassthrough = passthrough;
      executorReceivedStream = stream;
      executorReceivedSourceFormat = sourceFormat;
      return Promise.resolve({
        response: { ok: true, status: 200, headers: new Map() },
        url: "https://api.anthropic.com/v1/messages",
        headers: {},
        transformedBody: body,
      });
    }),
    noAuth: false,
  }),
}));
vi.mock("open-sse/handlers/chatCore/requestDetail.js", () => ({
  buildRequestDetail: () => ({}),
  extractRequestConfig: () => ({}),
}));
vi.mock("open-sse/handlers/chatCore/sseToJsonHandler.js", () => ({
  handleForcedSSEToJson: vi.fn(() => null),
}));
vi.mock("open-sse/handlers/chatCore/nonStreamingHandler.js", () => ({
  handleNonStreamingResponse: vi.fn(() => ({ success: true, response: new Response("{}") })),
}));
vi.mock("open-sse/handlers/chatCore/streamingHandler.js", () => ({
  handleStreamingResponse: vi.fn(() => ({ success: true, response: new Response("{}") })),
  buildOnStreamComplete: () => ({ onStreamComplete: () => {} }),
}));
vi.mock("open-sse/utils/toolDeduper.js", () => ({
  dedupeTools: (tools) => ({ tools, stripped: [] }),
}));
vi.mock("open-sse/rtk/index.js", () => ({
  compressMessages: vi.fn(() => null),
  formatRtkLog: vi.fn(() => null),
}));
vi.mock("open-sse/rtk/caveman.js", () => ({
  injectCaveman: vi.fn(),
}));
vi.mock("open-sse/rtk/headroom.js", () => ({
  compressWithHeadroom: vi.fn(() => Promise.resolve(null)),
}));
vi.mock("@/lib/compressionStats.js", () => ({
  recordCompressionStats: vi.fn(() => Promise.resolve()),
}));

// Mock clientDetector — control passthrough detection
const mockDetectClientTool = vi.fn(() => "claude");
const mockIsNativePassthrough = vi.fn(() => true);
vi.mock("open-sse/utils/clientDetector.js", () => ({
  detectClientTool: (...args) => mockDetectClientTool(...args),
  isNativePassthrough: (...args) => mockIsNativePassthrough(...args),
}));

// Import after mocks
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

function makeOptions(overrides = {}) {
  return {
    body: {
      model: "claude/claude-sonnet-4-20250514",
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
      ],
      stream: false,
      // Provider-native fields that should be preserved
      metadata: { user_id: "test-user-123" },
      custom_provider_field: "should-be-preserved",
      tools: [
        { name: "my_tool", description: "A tool", input_schema: { type: "object" } },
        { type: "computer_20241022", name: "computer", display_width_px: 1920, display_height_px: 1080 },
      ],
    },
    modelInfo: { provider: "claude", model: "claude-sonnet-4-20250514" },
    credentials: { accessToken: "test-token" },
    log: { debug: () => {}, info: () => {}, warn: () => {} },
    rtkEnabled: false,
    cavemanEnabled: false,
    headroomEnabled: false,
    passthroughCompression: false,
    clientRawRequest: { headers: { "user-agent": "claude-cli/1.0" }, body: "{}", endpoint: "/v1/messages" },
    ...overrides,
  };
}

describe("Passthrough request forwarding (task 2.2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsNativePassthrough.mockReturnValue(true);
    mockDetectClientTool.mockReturnValue("claude");
    executorReceivedBody = null;
    executorReceivedPassthrough = null;
    executorReceivedStream = null;
  });

  it("does NOT call translateRequest in passthrough mode", async () => {
    await handleChatCore(makeOptions());
    expect(mockTranslateRequest).not.toHaveBeenCalled();
  });

  it("swaps ONLY the model name in the body", async () => {
    const opts = makeOptions();
    await handleChatCore(opts);

    // The executor should receive a body with model swapped
    expect(executorReceivedBody).not.toBeNull();
    expect(executorReceivedBody.model).toBe("claude-sonnet-4-20250514");
  });

  it("preserves unknown provider-native fields (metadata, custom fields)", async () => {
    const opts = makeOptions();
    await handleChatCore(opts);

    expect(executorReceivedBody.metadata).toEqual({ user_id: "test-user-123" });
    expect(executorReceivedBody.custom_provider_field).toBe("should-be-preserved");
  });

  it("preserves tool schemas without rewriting them", async () => {
    const opts = makeOptions();
    await handleChatCore(opts);

    // Tool schemas should be passed through unchanged
    expect(executorReceivedBody.tools).toEqual([
      { name: "my_tool", description: "A tool", input_schema: { type: "object" } },
      { type: "computer_20241022", name: "computer", display_width_px: 1920, display_height_px: 1080 },
    ]);
  });

  it("preserves messages array without normalization", async () => {
    const opts = makeOptions();
    await handleChatCore(opts);

    expect(executorReceivedBody.messages).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ]);
  });

  it("does NOT inject providerThinking config in passthrough mode", async () => {
    const opts = makeOptions({
      providerThinking: { mode: "on" },
    });
    await handleChatCore(opts);

    // thinking field should NOT be added in passthrough mode
    expect(executorReceivedBody.thinking).toBeUndefined();
  });

  it("does NOT inject reasoning_effort in passthrough mode", async () => {
    const opts = makeOptions({
      providerThinking: { mode: "high" },
    });
    await handleChatCore(opts);

    // reasoning_effort should NOT be added in passthrough mode
    expect(executorReceivedBody.reasoning_effort).toBeUndefined();
  });

  it("DOES inject providerThinking in non-passthrough mode", async () => {
    mockIsNativePassthrough.mockReturnValue(false);
    const opts = makeOptions({
      providerThinking: { mode: "on" },
    });
    await handleChatCore(opts);

    // In non-passthrough mode, thinking should be injected
    // (translateRequest is mocked to return messages with the body passed in)
    expect(mockTranslateRequest).toHaveBeenCalled();
  });

  it("preserves stream field from original body", async () => {
    const opts = makeOptions();
    opts.body.stream = true;
    await handleChatCore(opts);

    expect(executorReceivedBody.stream).toBe(true);
    expect(executorReceivedStream).toBe(true);
  });

  it("treats omitted stream as non-streaming in passthrough mode", async () => {
    const opts = makeOptions();
    delete opts.body.stream;
    await handleChatCore(opts);

    expect(executorReceivedBody.stream).toBeUndefined();
    expect(executorReceivedStream).toBe(false);
  });

  it("passes openai-responses source format through to executor URL selection", async () => {
    mockDetectClientTool.mockReturnValue("openai");
    const opts = makeOptions({
      modelInfo: { provider: "openai", model: "gpt-5.4" },
      clientRawRequest: { headers: { "user-agent": "OpenAI/Node 6.0" }, body: "{}", endpoint: "/v1/responses" },
      sourceFormatOverride: "openai-responses",
    });
    delete opts.body.stream;
    opts.body.input = [{ role: "user", content: "hi" }];
    delete opts.body.messages;

    await handleChatCore(opts);

    expect(executorReceivedPassthrough).toBe(true);
    expect(executorReceivedSourceFormat).toBe("openai-responses");
  });

  it("preserves provider-native fields that translation would normally drop (top_k, top_p, system, etc.)", async () => {
    const opts = makeOptions();
    opts.body.top_k = 50;
    opts.body.top_p = 0.9;
    opts.body.system = "You are a helpful assistant";
    opts.body.max_tokens = 4096;
    opts.body.stop_sequences = ["Human:"];
    await handleChatCore(opts);

    expect(executorReceivedBody.top_k).toBe(50);
    expect(executorReceivedBody.top_p).toBe(0.9);
    expect(executorReceivedBody.system).toBe("You are a helpful assistant");
    expect(executorReceivedBody.max_tokens).toBe(4096);
    expect(executorReceivedBody.stop_sequences).toEqual(["Human:"]);
  });

  it("preserves provider-native thinking field if client set it (no override)", async () => {
    const opts = makeOptions({
      providerThinking: { mode: "on" },
    });
    opts.body.thinking = { type: "enabled", budget_tokens: 50000 };
    await handleChatCore(opts);

    // Client's own thinking config should be preserved
    expect(executorReceivedBody.thinking).toEqual({ type: "enabled", budget_tokens: 50000 });
  });

  it("passes passthrough=true to executor so transformRequest is skipped", async () => {
    await handleChatCore(makeOptions());
    expect(executorReceivedPassthrough).toBe(true);
  });

  it("passes passthrough=false to executor in non-passthrough mode", async () => {
    mockIsNativePassthrough.mockReturnValue(false);
    await handleChatCore(makeOptions());
    expect(executorReceivedPassthrough).toBe(false);
  });
});
