/**
 * Cache-safe compression in passthrough mode.
 *
 * Savers (RTK, Headroom, Caveman) run when individually enabled — including
 * native Claude Code passthrough. cache_control boundaries are never mutated.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
  getModelUpstreamId: (_alias, modelId) => modelId,
  getModelRequestExtras: () => null,
  getModelsByProviderId: () => [],
  PROVIDER_ID_TO_ALIAS: {},
}));
vi.mock("open-sse/utils/error.js", () => ({
  createErrorResult: (status, msg) => ({ success: false, status, error: msg }),
  parseUpstreamError: vi.fn(),
  formatProviderError: (err) => err.message,
  VALIDATION_ERROR_TYPES: {},
  PROXY_INTERNAL_ERROR_CODES: {
    COMPRESSION_RESTORE_FAILED: "compression_restore_failed",
    CACHE_INTEGRITY_FAILED: "cache_integrity_failed",
  },
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

vi.mock("@/lib/compressionStats.js", () => ({
  recordCompressionStats: vi.fn(() => Promise.resolve()),
  saveCompressionStats: vi.fn(() => Promise.resolve()),
}));

const mockDetectClientTool = vi.fn(() => "claude");
const mockIsNativePassthrough = vi.fn(() => true);
vi.mock("open-sse/utils/clientDetector.js", () => ({
  detectClientTool: (...args) => mockDetectClientTool(...args),
  isNativePassthrough: (...args) => mockIsNativePassthrough(...args),
  shouldUseNativePassthrough: (...args) => mockIsNativePassthrough(...args),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { translateRequest } = await import("../../open-sse/translator/index.js");

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
    passthroughCompression: true,
    clientRawRequest: { headers: { "user-agent": "claude-cli/1.0" }, body: "{}", endpoint: "/v1/messages" },
    ...overrides,
  };
}

describe("Cache-safe compression in passthrough", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsNativePassthrough.mockReturnValue(true);
    mockDetectClientTool.mockReturnValue("claude");
  });

  it("runs RTK in passthrough when rtkEnabled", async () => {
    await handleChatCore(makeOptions({ rtkEnabled: true }));
    expect(mockCompressMessages).toHaveBeenCalled();
  });

  it("runs Caveman in passthrough when cavemanEnabled and no cache breakpoints", async () => {
    await handleChatCore(makeOptions({ cavemanEnabled: true, cavemanLevel: "lite" }));
    expect(mockInjectCaveman).toHaveBeenCalled();
  });

  it("skips Caveman in passthrough when client sent cache_control breakpoints", async () => {
    const body = makeBody();
    body.system = [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }];
    await handleChatCore(makeOptions({ body, cavemanEnabled: true, cavemanLevel: "lite" }));
    expect(mockInjectCaveman).not.toHaveBeenCalled();
  });

  it("skips RTK and Headroom when cache_control present even with passthroughCompression", async () => {
    const body = makeBody();
    body.system = [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }];
    await handleChatCore(makeOptions({ body, rtkEnabled: true, headroomEnabled: true }));
    expect(mockCompressMessages).not.toHaveBeenCalled();
    expect(mockCompressWithHeadroom).not.toHaveBeenCalled();
  });

  it("runs Headroom in passthrough when headroomEnabled", async () => {
    await handleChatCore(makeOptions({ headroomEnabled: true }));
    expect(mockCompressWithHeadroom).toHaveBeenCalled();
  });

  it("skips savers when each subsystem is disabled", async () => {
    await handleChatCore(makeOptions({ rtkEnabled: false, cavemanEnabled: false, headroomEnabled: false }));
    expect(mockCompressMessages).not.toHaveBeenCalled();
    expect(mockInjectCaveman).not.toHaveBeenCalled();
    expect(mockCompressWithHeadroom).not.toHaveBeenCalled();
  });

  it("skips compression when body snapshot fails (non-serializable fields)", async () => {
    mockCompressMessages.mockClear();
    mockIsNativePassthrough.mockReturnValue(false);
    vi.mocked(translateRequest).mockReturnValueOnce({
      model: "test",
      messages: [{ role: "user", content: 1n }],
    });
    const result = await handleChatCore(makeOptions());
    expect(result.success).toBe(true);
    expect(mockCompressMessages).not.toHaveBeenCalled();
  });

  it("continues with original content if compression throws and snapshot exists", async () => {
    mockCompressMessages.mockImplementation(() => { throw new Error("RTK exploded"); });
    const body = makeBody();
    const originalMessages = JSON.parse(JSON.stringify(body.messages));
    const result = await handleChatCore(makeOptions({ body }));
    expect(result.success).toBe(true);
    expect(body.messages).toEqual(originalMessages);
  });

  it("runs RTK in non-passthrough when rtkEnabled", async () => {
    mockIsNativePassthrough.mockReturnValue(false);
    await handleChatCore(makeOptions());
    expect(mockCompressMessages).toHaveBeenCalled();
  });

  it("runs RTK → Headroom → Caveman in order when all enabled", async () => {
    mockIsNativePassthrough.mockReturnValue(false);
    const order = [];
    mockCompressMessages.mockImplementation(() => {
      order.push("rtk");
      return { bytesBefore: 100, bytesAfter: 50, hits: [{ filter: "grep" }] };
    });
    mockCompressWithHeadroom.mockImplementation(async () => {
      order.push("headroom");
      return { before: 100, after: 60, saved: 40 };
    });
    mockInjectCaveman.mockImplementation(() => {
      order.push("caveman");
      return true;
    });
    await handleChatCore(makeOptions({ headroomEnabled: true }));
    expect(order).toEqual(["rtk", "headroom", "caveman"]);
  });
});
