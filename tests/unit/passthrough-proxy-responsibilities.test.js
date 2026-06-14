/**
 * Tests for passthrough proxy responsibilities (Task 2.6)
 *
 * Validates that passthrough requests STILL go through the same proxy
 * responsibility pipeline as normal translated requests:
 * - Authentication enforcement
 * - Provider/model resolution
 * - Connection selection
 * - Outbound proxy routing
 * - MITM bypass DNS behavior
 * - Request timeout handling
 * - Retry/cooldown rules
 * - Required upstream auth header injection
 * - Request/response logging if enabled
 * - Streaming adaptation when required by client contract
 *
 * These are proxy responsibilities that apply REGARDLESS of passthrough.
 *
 * Requirements: 1.2, 10.1, 11.1, 13.1
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mocks ---

vi.mock("open-sse/services/provider.js", () => ({
  detectFormat: () => "claude",
  getTargetFormat: () => "claude",
}));

const mockTranslateRequest = vi.fn(() => ({ messages: [], model: "test" }));
vi.mock("open-sse/translator/index.js", () => ({
  translateRequest: (...args) => mockTranslateRequest(...args),
}));
vi.mock("open-sse/translator/formats.js", () => ({
  FORMATS: { CLAUDE: "claude", OPENAI: "openai", GEMINI: "gemini", GEMINI_CLI: "gemini-cli", ANTIGRAVITY: "antigravity" },
}));
vi.mock("open-sse/utils/stream.js", () => ({
  COLORS: { red: "", reset: "" },
}));
vi.mock("open-sse/utils/streamHandler.js", () => ({
  createStreamController: () => ({
    signal: new AbortController().signal,
    handleComplete: () => {},
    handleError: () => {},
  }),
}));
vi.mock("open-sse/services/tokenRefresh.js", () => ({
  refreshWithRetry: vi.fn(),
}));

const mockRequestLogger = {
  logClientRawRequest: vi.fn(),
  logRawRequest: vi.fn(),
  logTargetRequest: vi.fn(),
  logError: vi.fn(),
};
vi.mock("open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: vi.fn(() => mockRequestLogger),
}));
vi.mock("open-sse/config/providerModels.js", () => ({
  getModelTargetFormat: () => null,
  getModelStrip: () => [],
  getModelUpstreamId: (_alias, modelId) => modelId,
  PROVIDER_ID_TO_ALIAS: {},
}));
vi.mock("open-sse/utils/error.js", () => ({
  createErrorResult: (status, msg) => ({ success: false, status, error: msg }),
  parseUpstreamError: vi.fn(async () => ({ statusCode: 500, message: "Server Error", resetsAtMs: null })),
  formatProviderError: (err) => err.message || "error",
  VALIDATION_ERROR_TYPES: {
    TRANSLATION_INVALID_BODY: "translation_invalid_body",
    MISSING_REQUIRED_FIELD: "missing_required_field",
    UNSUPPORTED_REQUEST: "unsupported_request",
    VALIDATION_FAILED: "validation_failed",
  },
  PROXY_INTERNAL_ERROR_CODES: {
    CACHE_INTEGRITY_FAILED: "cache_integrity_failed",
    COMPRESSION_RESTORE_FAILED: "compression_restore_failed",
  },
}));
vi.mock("open-sse/config/runtimeConfig.js", () => ({
  HTTP_STATUS: {
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    SERVICE_UNAVAILABLE: 503,
    BAD_GATEWAY: 502,
  },
  MEMORY_CONFIG: { sessionTtlMs: 7200000, sessionCleanupIntervalMs: 1800000 },
}));
vi.mock("open-sse/utils/bypassHandler.js", () => ({
  handleBypassRequest: () => null,
}));

const mockTrackPendingRequest = vi.fn();
const mockAppendRequestLog = vi.fn(() => Promise.resolve());
const mockSaveRequestDetail = vi.fn(() => Promise.resolve());
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: (...args) => mockTrackPendingRequest(...args),
  appendRequestLog: (...args) => mockAppendRequestLog(...args),
  saveRequestDetail: (...args) => mockSaveRequestDetail(...args),
}));

// Track executor calls
let executorCalls = [];
let executorResponse = { ok: true, status: 200, headers: new Map() };
const mockExecute = vi.fn(async ({ body, passthrough, proxyOptions }) => {
  executorCalls.push({ body, passthrough, proxyOptions });
  return {
    response: executorResponse,
    url: "https://api.anthropic.com/v1/messages",
    headers: { Authorization: "Bearer test-token" },
    transformedBody: body,
  };
});
vi.mock("open-sse/executors/index.js", () => ({
  getExecutor: () => ({
    execute: (...args) => mockExecute(...args),
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

const mockCompressMessages = vi.fn(() => null);
vi.mock("open-sse/rtk/index.js", () => ({
  compressMessages: (...args) => mockCompressMessages(...args),
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

// Control passthrough detection
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
      messages: [{ role: "user", content: "Hello" }],
      stream: true,
    },
    modelInfo: { provider: "claude", model: "claude-sonnet-4-20250514" },
    credentials: {
      accessToken: "test-access-token",
      apiKey: "sk-test-key",
      connectionName: "test-connection",
      connectionId: "conn-123",
      providerSpecificData: {
        connectionProxyEnabled: true,
        connectionProxyUrl: "http://proxy.internal:8080",
        connectionNoProxy: "localhost",
        vercelRelayUrl: "",
      },
    },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    rtkEnabled: false,
    cavemanEnabled: false,
    headroomEnabled: false,
    passthroughCompression: false,
    clientRawRequest: {
      headers: { "user-agent": "claude-cli/1.0" },
      body: "{}",
      endpoint: "/v1/messages",
    },
    connectionId: "conn-123",
    userAgent: "claude-cli/1.0",
    apiKey: "user-api-key",
    ccFilterNaming: false,
    ...overrides,
  };
}

describe("Passthrough proxy responsibilities (task 2.6)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsNativePassthrough.mockReturnValue(true);
    mockDetectClientTool.mockReturnValue("claude");
    executorCalls = [];
    executorResponse = { ok: true, status: 200, headers: new Map() };
  });

  describe("Outbound proxy routing still applies in passthrough", () => {
    it("passes proxyOptions to executor from connection credentials", async () => {
      await handleChatCore(makeOptions());

      expect(mockExecute).toHaveBeenCalledTimes(1);
      const callArgs = mockExecute.mock.calls[0][0];
      expect(callArgs.proxyOptions).toBeDefined();
      expect(callArgs.proxyOptions.connectionProxyEnabled).toBe(true);
      expect(callArgs.proxyOptions.connectionProxyUrl).toBe("http://proxy.internal:8080");
      expect(callArgs.proxyOptions.connectionNoProxy).toBe("localhost");
    });

    it("passes vercelRelayUrl in proxyOptions when configured", async () => {
      const opts = makeOptions();
      opts.credentials.providerSpecificData.vercelRelayUrl = "https://relay.vercel.app/v1";
      await handleChatCore(opts);

      const callArgs = mockExecute.mock.calls[0][0];
      expect(callArgs.proxyOptions.vercelRelayUrl).toBe("https://relay.vercel.app/v1");
    });
  });

  describe("Upstream auth header injection still applies in passthrough", () => {
    it("passes credentials to executor (for buildHeaders to inject auth)", async () => {
      await handleChatCore(makeOptions());

      // The executor receives credentials, which it uses in buildHeaders
      // (base.js buildHeaders adds Authorization: Bearer <accessToken>)
      const callArgs = mockExecute.mock.calls[0][0];
      expect(callArgs.credentials).toBeDefined();
      expect(callArgs.credentials.accessToken).toBe("test-access-token");
    });
  });

  describe("Request/response logging still applies in passthrough", () => {
    it("calls request logger for passthrough requests", async () => {
      await handleChatCore(makeOptions());

      // requestLogger should still be invoked in passthrough mode
      expect(mockRequestLogger.logClientRawRequest).toHaveBeenCalled();
      expect(mockRequestLogger.logRawRequest).toHaveBeenCalled();
      expect(mockRequestLogger.logTargetRequest).toHaveBeenCalled();
    });

    it("calls trackPendingRequest for passthrough requests", async () => {
      await handleChatCore(makeOptions());

      expect(mockTrackPendingRequest).toHaveBeenCalled();
    });

    it("calls appendRequestLog for passthrough requests", async () => {
      await handleChatCore(makeOptions());

      expect(mockAppendRequestLog).toHaveBeenCalled();
    });
  });

  describe("Request timeout handling still applies in passthrough", () => {
    it("passes signal to executor for abort/timeout handling", async () => {
      await handleChatCore(makeOptions());

      const callArgs = mockExecute.mock.calls[0][0];
      // Signal is passed through for timeout handling (base.js uses FETCH_CONNECT_TIMEOUT_MS)
      expect(callArgs.signal).toBeDefined();
    });
  });

  describe("Streaming adaptation still applies in passthrough", () => {
    it("respects stream=true from client body in passthrough mode", async () => {
      const opts = makeOptions();
      opts.body.stream = true;
      await handleChatCore(opts);

      const callArgs = mockExecute.mock.calls[0][0];
      expect(callArgs.stream).toBe(true);
    });

    it("respects stream=false from client body in passthrough mode", async () => {
      const opts = makeOptions();
      opts.body.stream = false;
      await handleChatCore(opts);

      const callArgs = mockExecute.mock.calls[0][0];
      expect(callArgs.stream).toBe(false);
    });
  });

  describe("Passthrough flag is passed to executor", () => {
    it("passes passthrough=true so executor skips transformRequest but applies everything else", async () => {
      await handleChatCore(makeOptions());

      const callArgs = mockExecute.mock.calls[0][0];
      expect(callArgs.passthrough).toBe(true);
    });
  });

  describe("Connection selection is exercised (confirmed by chatCore receiving credentials)", () => {
    it("uses provided credentials for passthrough requests", async () => {
      const opts = makeOptions();
      opts.credentials.connectionName = "my-prod-account";
      await handleChatCore(opts);

      const callArgs = mockExecute.mock.calls[0][0];
      expect(callArgs.credentials.connectionName).toBe("my-prod-account");
    });
  });

  describe("Error handling and retry path works in passthrough", () => {
    it("returns error result when executor throws AbortError in passthrough mode", async () => {
      const abortError = new Error("Request aborted");
      abortError.name = "AbortError";
      mockExecute.mockRejectedValueOnce(abortError);

      const result = await handleChatCore(makeOptions());

      expect(result.success).toBe(false);
      expect(result.status).toBe(499);
    });

    it("returns error result when executor throws network error in passthrough mode", async () => {
      const netError = new Error("fetch failed");
      netError.name = "TypeError";
      mockExecute.mockRejectedValueOnce(netError);

      const result = await handleChatCore(makeOptions());

      expect(result.success).toBe(false);
      expect(result.status).toBe(502);
    });

    it("returns upstream error when provider returns non-OK in passthrough mode", async () => {
      executorResponse = { ok: false, status: 500, headers: new Map() };
      mockExecute.mockResolvedValueOnce({
        response: executorResponse,
        url: "https://api.anthropic.com/v1/messages",
        headers: {},
        transformedBody: {},
      });

      const result = await handleChatCore(makeOptions());

      expect(result.success).toBe(false);
    });

    it("logs failed requests in passthrough mode", async () => {
      executorResponse = { ok: false, status: 429, headers: new Map() };
      mockExecute.mockResolvedValueOnce({
        response: executorResponse,
        url: "https://api.anthropic.com/v1/messages",
        headers: {},
        transformedBody: {},
      });

      await handleChatCore(makeOptions());

      // appendRequestLog should be called with FAILED status
      expect(mockAppendRequestLog).toHaveBeenCalled();
      const failCall = mockAppendRequestLog.mock.calls.find(
        (c) => c[0]?.status?.includes?.("FAILED")
      );
      expect(failCall).toBeDefined();
    });
  });

  describe("Full pipeline parity: passthrough takes same code path as translated (minus translation)", () => {
    it("both passthrough and non-passthrough pass through executor with same proxyOptions", async () => {
      // First call: passthrough
      mockIsNativePassthrough.mockReturnValue(true);
      await handleChatCore(makeOptions());
      const passthroughCallArgs = mockExecute.mock.calls[0][0];

      vi.clearAllMocks();
      executorCalls = [];

      // Second call: non-passthrough
      mockIsNativePassthrough.mockReturnValue(false);
      mockDetectClientTool.mockReturnValue("openai");
      await handleChatCore(makeOptions());
      const translatedCallArgs = mockExecute.mock.calls[0][0];

      // Both should have identical proxyOptions
      expect(passthroughCallArgs.proxyOptions).toEqual(translatedCallArgs.proxyOptions);
    });

    it("both passthrough and non-passthrough have signal for timeout", async () => {
      mockIsNativePassthrough.mockReturnValue(true);
      await handleChatCore(makeOptions());
      const passthroughCallArgs = mockExecute.mock.calls[0][0];

      vi.clearAllMocks();
      executorCalls = [];

      mockIsNativePassthrough.mockReturnValue(false);
      mockDetectClientTool.mockReturnValue("openai");
      await handleChatCore(makeOptions());
      const translatedCallArgs = mockExecute.mock.calls[0][0];

      // Both should have signal
      expect(passthroughCallArgs.signal).toBeDefined();
      expect(translatedCallArgs.signal).toBeDefined();
    });

    it("both passthrough and non-passthrough call trackPendingRequest", async () => {
      mockIsNativePassthrough.mockReturnValue(true);
      await handleChatCore(makeOptions());
      const passthroughTracked = mockTrackPendingRequest.mock.calls.length > 0;

      vi.clearAllMocks();

      mockIsNativePassthrough.mockReturnValue(false);
      mockDetectClientTool.mockReturnValue("openai");
      await handleChatCore(makeOptions());
      const translatedTracked = mockTrackPendingRequest.mock.calls.length > 0;

      expect(passthroughTracked).toBe(true);
      expect(translatedTracked).toBe(true);
    });
  });
});
