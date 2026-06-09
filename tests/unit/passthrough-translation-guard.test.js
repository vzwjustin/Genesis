/**
 * Tests for Task 1.5: Translation does NOT run when passthrough mode is active
 *
 * Validates:
 * - translateRequest is NOT called in passthrough mode
 * - Response translation (needsTranslation) naturally skips when sourceFormat === targetFormat
 * - Tool deduplication does NOT run in passthrough mode
 * - No other code paths accidentally translate the body in passthrough mode
 *
 * Requirements: 1.2, 1.3
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies
vi.mock("open-sse/services/provider.js", () => ({
  detectFormat: () => "claude",
  getTargetFormat: () => "claude",
}));

const mockTranslateRequest = vi.fn(() => ({ messages: [], model: "test" }));
vi.mock("open-sse/translator/index.js", () => ({
  translateRequest: (...args) => mockTranslateRequest(...args),
  needsTranslation: (source, target) => source !== target,
}));
vi.mock("open-sse/translator/formats.js", () => ({
  FORMATS: { CLAUDE: "claude", OPENAI: "openai", GEMINI: "gemini", GEMINI_CLI: "gemini-cli", ANTIGRAVITY: "antigravity" },
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
    logProviderResponse: () => {},
    logConvertedResponse: () => {},
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

let executorReceivedBody = null;
let executorReceivedPassthrough = null;
vi.mock("open-sse/executors/index.js", () => ({
  getExecutor: () => ({
    execute: vi.fn(({ body, passthrough }) => {
      executorReceivedBody = body;
      executorReceivedPassthrough = passthrough;
      return Promise.resolve({
        response: { ok: true, status: 200, headers: new Map(), json: () => Promise.resolve({ id: "msg_1", type: "message", role: "assistant", content: [{ type: "text", text: "Hello" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } }) },
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
  extractUsageFromResponse: () => ({ prompt_tokens: 10, completion_tokens: 5 }),
  saveUsageStats: () => {},
}));
vi.mock("open-sse/handlers/chatCore/sseToJsonHandler.js", () => ({
  handleForcedSSEToJson: vi.fn(() => null),
}));

// Track calls to nonStreamingHandler to verify it receives correct format info
const mockHandleNonStreamingResponse = vi.fn(() => ({
  success: true,
  response: new Response(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", content: [{ type: "text", text: "Hello" }] }), { headers: { "Content-Type": "application/json" } })
}));
vi.mock("open-sse/handlers/chatCore/nonStreamingHandler.js", () => ({
  handleNonStreamingResponse: (...args) => mockHandleNonStreamingResponse(...args),
}));
vi.mock("open-sse/handlers/chatCore/streamingHandler.js", () => ({
  handleStreamingResponse: vi.fn(() => ({ success: true, response: new Response("{}") })),
  buildOnStreamComplete: () => ({ onStreamComplete: () => {} }),
}));

const mockDedupeTools = vi.fn((tools) => ({ tools, stripped: [] }));
vi.mock("open-sse/utils/toolDeduper.js", () => ({
  dedupeTools: (...args) => mockDedupeTools(...args),
}));

const mockCompressMessages = vi.fn(() => null);
vi.mock("open-sse/rtk/index.js", () => ({
  compressMessages: (...args) => mockCompressMessages(...args),
  formatRtkLog: vi.fn(() => null),
}));
const mockInjectCaveman = vi.fn();
vi.mock("open-sse/rtk/caveman.js", () => ({
  injectCaveman: (...args) => mockInjectCaveman(...args),
}));
vi.mock("open-sse/rtk/headroom.js", () => ({
  compressWithHeadroom: vi.fn(() => Promise.resolve(null)),
}));
vi.mock("@/lib/compressionStats.js", () => ({
  recordCompressionStats: vi.fn(() => Promise.resolve()),
}));

// Control passthrough detection
const mockDetectClientTool = vi.fn(() => "claude");
const mockIsNativePassthrough = vi.fn(() => true);
vi.mock("open-sse/utils/clientDetector.js", () => ({
  detectClientTool: (...args) => mockDetectClientTool(...args),
  isNativePassthrough: (...args) => mockIsNativePassthrough(...args),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

function makeOptions(overrides = {}) {
  return {
    body: {
      model: "claude/claude-sonnet-4-20250514",
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
        { role: "assistant", content: [{ type: "text", text: "Hi there!" }] },
      ],
      stream: false,
      tools: [
        { name: "my_tool", description: "A tool", input_schema: { type: "object" } },
        { type: "computer_20241022", name: "computer", display_width_px: 1920, display_height_px: 1080 },
      ],
    },
    modelInfo: { provider: "claude", model: "claude-sonnet-4-20250514" },
    credentials: { accessToken: "test-token" },
    log: { debug: () => {}, info: () => {}, warn: () => {} },
    rtkEnabled: true,
    cavemanEnabled: true,
    cavemanLevel: 2,
    headroomEnabled: false,
    passthroughCompression: false,
    clientRawRequest: { headers: { "user-agent": "claude-cli/1.0" }, body: "{}", endpoint: "/v1/messages" },
    ...overrides,
  };
}

describe("Task 1.5: Translation does NOT run when passthrough mode is active", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsNativePassthrough.mockReturnValue(true);
    mockDetectClientTool.mockReturnValue("claude");
    executorReceivedBody = null;
    executorReceivedPassthrough = null;
  });

  describe("Request translation guard", () => {
    it("translateRequest is NOT called when passthrough is true", async () => {
      await handleChatCore(makeOptions());
      expect(mockTranslateRequest).not.toHaveBeenCalled();
    });

    it("translateRequest IS called when passthrough is false", async () => {
      mockIsNativePassthrough.mockReturnValue(false);
      await handleChatCore(makeOptions());
      expect(mockTranslateRequest).toHaveBeenCalled();
    });
  });

  describe("Tool deduplication guard", () => {
    it("dedupeTools is NOT called when passthrough is true (even for claude client)", async () => {
      // Claude client with tools — dedup should still be skipped in passthrough
      await handleChatCore(makeOptions());
      expect(mockDedupeTools).not.toHaveBeenCalled();
    });

    it("dedupeTools IS called for claude client when passthrough is false", async () => {
      mockIsNativePassthrough.mockReturnValue(false);
      // The mock translateRequest must return a body with tools array for dedup to trigger
      mockTranslateRequest.mockReturnValueOnce({
        messages: [{ role: "user", content: "Hello" }],
        model: "test",
        tools: [{ name: "my_tool", description: "A tool", input_schema: { type: "object" } }],
      });
      await handleChatCore(makeOptions());
      expect(mockDedupeTools).toHaveBeenCalled();
    });
  });

  describe("Compression guard in passthrough mode", () => {
    it("RTK compressMessages is NOT called when passthrough and passthroughCompression is false", async () => {
      await handleChatCore(makeOptions({ passthroughCompression: false }));
      expect(mockCompressMessages).not.toHaveBeenCalled();
    });

    it("Caveman injectCaveman is NOT called when passthrough and passthroughCompression is false", async () => {
      await handleChatCore(makeOptions({ passthroughCompression: false }));
      expect(mockInjectCaveman).not.toHaveBeenCalled();
    });

    it("RTK compressMessages IS called when passthrough and passthroughCompression is explicitly enabled", async () => {
      await handleChatCore(makeOptions({ passthroughCompression: true }));
      expect(mockCompressMessages).toHaveBeenCalled();
    });
  });

  describe("Response translation guard", () => {
    it("in passthrough mode, sourceFormat === targetFormat so needsTranslation returns false", async () => {
      // In passthrough mode (claude → claude), sourceFormat and targetFormat are both "claude"
      // The nonStreamingHandler receives these and uses needsTranslation(targetFormat, sourceFormat)
      // which returns false (sourceFormat === targetFormat), so no response translation occurs
      await handleChatCore(makeOptions());

      // Verify that the non-streaming handler was called with matching formats
      expect(mockHandleNonStreamingResponse).toHaveBeenCalled();
      const callArgs = mockHandleNonStreamingResponse.mock.calls[0][0];
      expect(callArgs.sourceFormat).toBe("claude");
      expect(callArgs.targetFormat).toBe("claude");
      // When sourceFormat === targetFormat, needsTranslation returns false
      // so response translation is naturally skipped
    });
  });

  describe("Executor receives passthrough flag", () => {
    it("executor is called with passthrough=true so it can skip internal transforms", async () => {
      await handleChatCore(makeOptions());
      expect(executorReceivedPassthrough).toBe(true);
    });
  });

  describe("Body integrity in passthrough mode", () => {
    it("original message structure is preserved without any field normalization", async () => {
      const opts = makeOptions();
      opts.body.custom_anthropic_field = { nested: "value" };
      opts.body.system = [{ type: "text", text: "System prompt", cache_control: { type: "ephemeral" } }];
      await handleChatCore(opts);

      expect(executorReceivedBody.custom_anthropic_field).toEqual({ nested: "value" });
      expect(executorReceivedBody.system).toEqual([{ type: "text", text: "System prompt", cache_control: { type: "ephemeral" } }]);
      expect(executorReceivedBody.messages).toEqual([
        { role: "user", content: [{ type: "text", text: "Hello" }] },
        { role: "assistant", content: [{ type: "text", text: "Hi there!" }] },
      ]);
    });

    it("only the model field is changed in the body", async () => {
      const opts = makeOptions();
      const originalBody = JSON.parse(JSON.stringify(opts.body));
      await handleChatCore(opts);

      // Model is swapped to the resolved model
      expect(executorReceivedBody.model).toBe("claude-sonnet-4-20250514");
      // Everything else should match the original
      delete originalBody.model;
      const receivedWithoutModel = { ...executorReceivedBody };
      delete receivedWithoutModel.model;
      expect(receivedWithoutModel).toEqual(originalBody);
    });
  });
});
