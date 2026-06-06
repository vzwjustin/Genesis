/**
 * Tests for passthrough compression guard (Task 2.3)
 *
 * Validates:
 * - Compression (RTK, Headroom, Caveman) is NOT applied in passthrough mode by default
 * - Compression IS applied in passthrough mode when passthroughCompression is explicitly enabled
 * - If compression is explicitly enabled and fails in passthrough mode, request continues with original content
 * - Provider-native message arrays are NOT altered in passthrough mode unless configured
 *
 * Requirements: 1.2, 7.3
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the dependencies that chatCore imports
vi.mock("open-sse/services/provider.js", () => ({
  detectFormat: () => "claude",
  getTargetFormat: () => "claude",
}));
vi.mock("open-sse/translator/index.js", () => ({
  translateRequest: vi.fn(() => ({ messages: [], model: "test" })),
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
vi.mock("open-sse/executors/index.js", () => ({
  getExecutor: () => ({
    execute: vi.fn(() => Promise.resolve({
      response: { ok: true, status: 200, headers: new Map() },
      url: "https://api.anthropic.com/v1/messages",
      headers: {},
      transformedBody: {},
    })),
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

// These are the key modules we need to spy on for this test
const mockCompressMessages = vi.fn(() => null);
const mockFormatRtkLog = vi.fn(() => null);
vi.mock("open-sse/rtk/index.js", () => ({
  compressMessages: (...args) => mockCompressMessages(...args),
  formatRtkLog: (...args) => mockFormatRtkLog(...args),
}));

const mockInjectCaveman = vi.fn();
vi.mock("open-sse/rtk/caveman.js", () => ({
  injectCaveman: (...args) => mockInjectCaveman(...args),
}));

const mockCompressWithHeadroom = vi.fn(() => Promise.resolve(null));
vi.mock("open-sse/rtk/headroom.js", () => ({
  compressWithHeadroom: (...args) => mockCompressWithHeadroom(...args),
}));

const mockRecordCompressionStats = vi.fn(() => Promise.resolve());
vi.mock("@/lib/compressionStats.js", () => ({
  recordCompressionStats: (...args) => mockRecordCompressionStats(...args),
}));

// Mock clientDetector — we control passthrough detection
const mockDetectClientTool = vi.fn(() => "claude");
const mockIsNativePassthrough = vi.fn(() => true);
vi.mock("open-sse/utils/clientDetector.js", () => ({
  detectClientTool: (...args) => mockDetectClientTool(...args),
  isNativePassthrough: (...args) => mockIsNativePassthrough(...args),
}));

// Import after mocks are set up
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

// Standard test body with messages that RTK could compress
function makeBody() {
  return {
    model: "claude/claude-sonnet-4-20250514",
    messages: [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x".repeat(1000) }] },
    ],
    stream: false,
  };
}

function makeOptions(overrides = {}) {
  return {
    body: makeBody(),
    modelInfo: { provider: "claude", model: "claude-sonnet-4-20250514" },
    credentials: { accessToken: "test-token" },
    log: { debug: () => {}, info: () => {}, warn: () => {} },
    rtkEnabled: true,
    cavemanEnabled: true,
    cavemanLevel: "full",
    headroomEnabled: false,
    passthroughCompression: false,
    clientRawRequest: { headers: { "user-agent": "claude-cli/1.0" }, body: "{}", endpoint: "/v1/messages" },
    ...overrides,
  };
}

describe("Passthrough compression guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsNativePassthrough.mockReturnValue(true);
    mockDetectClientTool.mockReturnValue("claude");
  });

  it("does NOT call compressMessages (RTK) in passthrough mode when passthroughCompression is disabled", async () => {
    await handleChatCore(makeOptions({ passthroughCompression: false }));
    expect(mockCompressMessages).not.toHaveBeenCalled();
  });

  it("does NOT call injectCaveman in passthrough mode when passthroughCompression is disabled", async () => {
    await handleChatCore(makeOptions({ passthroughCompression: false }));
    expect(mockInjectCaveman).not.toHaveBeenCalled();
  });

  it("does NOT call compressWithHeadroom in passthrough mode when passthroughCompression is disabled", async () => {
    await handleChatCore(makeOptions({ passthroughCompression: false, headroomEnabled: true }));
    expect(mockCompressWithHeadroom).not.toHaveBeenCalled();
  });

  it("preserves provider-native message arrays unmodified in passthrough mode (no passthroughCompression)", async () => {
    const body = makeBody();
    const originalMessages = JSON.parse(JSON.stringify(body.messages));
    await handleChatCore(makeOptions({ body, passthroughCompression: false }));
    // Messages should be byte-for-byte identical (no compression ran)
    expect(body.messages).toEqual(originalMessages);
  });

  it("DOES call compressMessages (RTK) in passthrough mode when passthroughCompression is explicitly enabled", async () => {
    await handleChatCore(makeOptions({ passthroughCompression: true }));
    expect(mockCompressMessages).toHaveBeenCalled();
  });

  it("DOES call injectCaveman in passthrough mode when passthroughCompression is explicitly enabled", async () => {
    await handleChatCore(makeOptions({ passthroughCompression: true }));
    expect(mockInjectCaveman).toHaveBeenCalled();
  });

  it("DOES call compressMessages in non-passthrough mode regardless of passthroughCompression setting", async () => {
    mockIsNativePassthrough.mockReturnValue(false);
    await handleChatCore(makeOptions({ passthroughCompression: false }));
    expect(mockCompressMessages).toHaveBeenCalled();
  });

  it("continues with original content if passthrough compression is enabled but throws", async () => {
    // Make RTK throw an error
    mockCompressMessages.mockImplementation(() => { throw new Error("RTK exploded"); });

    const body = makeBody();
    const originalMessages = JSON.parse(JSON.stringify(body.messages));

    const result = await handleChatCore(makeOptions({ body, passthroughCompression: true }));

    // Request should still succeed (not error out)
    expect(result.success).toBe(true);
    // Body messages should be restored to original
    expect(body.messages).toEqual(originalMessages);
  });

  it("passthroughCompression defaults to falsy when not provided (guard active)", async () => {
    // Call without passthroughCompression param at all
    const opts = makeOptions();
    delete opts.passthroughCompression;
    await handleChatCore(opts);
    expect(mockCompressMessages).not.toHaveBeenCalled();
    expect(mockInjectCaveman).not.toHaveBeenCalled();
  });
});
