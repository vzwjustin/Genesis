/**
 * Tests for passthrough error handling (Task 2.5)
 *
 * Validates:
 * - If passthrough provider resolution fails: return error (not a silent fallback to translation)
 * - Do NOT guess the intended provider
 * - Do NOT mutate the request into a different provider format
 *
 * Requirements: 1.2
 *
 * These tests validate the error paths at two levels:
 * 1. Model resolution layer (src/sse/handlers/chat.js) — provider resolves to null
 * 2. Core handler layer (open-sse/handlers/chatCore.js) — target format unavailable
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ===================================================================
// PART 1: Model resolution failures (handleSingleModelChat in chat.js)
// ===================================================================

// Mock @/lib/localDb for model.js resolution tests
vi.mock("@/lib/localDb", () => ({
  getModelAliases: vi.fn(() => Promise.resolve({})),
  getComboByName: vi.fn(() => Promise.resolve(null)),
  getProviderNodes: vi.fn(() => Promise.resolve([])),
}));

import { getModelInfo } from "../../src/sse/services/model.js";
import { getModelAliases, getComboByName, getProviderNodes } from "@/lib/localDb";

describe("Passthrough error handling — model resolution layer (Task 2.5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getModelAliases.mockResolvedValue({});
    getComboByName.mockResolvedValue(null);
    getProviderNodes.mockResolvedValue([]);
  });

  it("returns null provider when model cannot be resolved — signals error to caller", async () => {
    // An unresolvable model string must return null provider so the caller returns an error
    const result = await getModelInfo("unresolvable-model-xyz");
    expect(result.provider).toBeNull();
  });

  it("does NOT infer a provider from model name prefix (no guessing)", async () => {
    // Even model names that start with known prefixes must NOT be guessed
    const result = await getModelInfo("claude-something-new");
    expect(result.provider).toBeNull();
  });

  it("does NOT fall back to 'openai' as a default provider", async () => {
    const result = await getModelInfo("gpt-magic-model");
    expect(result.provider).toBeNull();
  });

  it("returns null provider for combo that has no valid models (empty targets)", async () => {
    // A combo match alone is not success — must resolve to valid targets
    getComboByName.mockResolvedValue({ name: "broken", models: [] });
    const result = await getModelInfo("broken");
    // getModelInfo sees the combo name match and returns null provider to signal combo handling
    // But getComboModels will return null because models is empty
    expect(result.provider).toBeNull();
  });
});

// ===================================================================
// PART 2: chatCore passthrough — target format resolution failure
// ===================================================================

// Reset modules for chatCore test suite
vi.mock("open-sse/services/provider.js", () => ({
  detectFormat: () => "claude",
  getTargetFormat: vi.fn(() => null), // Simulate target format resolution failure
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
  getModelTargetFormat: () => null, // No model-specific override either
  getModelStrip: () => [],
  getModelUpstreamId: (_alias, modelId) => modelId,
  getModelRequestExtras: () => null,
  PROVIDER_ID_TO_ALIAS: {},
}));
vi.mock("open-sse/utils/error.js", () => ({
  createErrorResult: (status, msg, resetsAtMs, options) => ({
    success: false,
    status,
    error: msg,
    response: new Response(JSON.stringify({ error: { message: msg } }), { status }),
    ...(options || {}),
  }),
  parseUpstreamError: vi.fn(),
  formatProviderError: (err) => err.message,
  VALIDATION_ERROR_TYPES: {
    TRANSLATION_INVALID_BODY: "translation_invalid_body",
    MISSING_REQUIRED_FIELD: "missing_required_field",
    UNSUPPORTED_REQUEST: "unsupported_request",
    VALIDATION_FAILED: "validation_failed",
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

const mockTranslateRequest = vi.fn(() => ({ messages: [], model: "test" }));

let executorReceivedBody = null;
const mockExecute = vi.fn(({ body }) => {
  executorReceivedBody = body;
  return Promise.resolve({
    response: { ok: true, status: 200, headers: new Map() },
    url: "https://api.example.com/v1/messages",
    headers: {},
    transformedBody: body,
  });
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

// Control passthrough detection
const mockDetectClientTool = vi.fn(() => "claude");
const mockIsNativePassthrough = vi.fn(() => true);
vi.mock("open-sse/utils/clientDetector.js", () => ({
  detectClientTool: (...args) => mockDetectClientTool(...args),
  isNativePassthrough: (...args) => mockIsNativePassthrough(...args),
  shouldUseNativePassthrough: (...args) => mockIsNativePassthrough(...args),
}));

// Import handleChatCore after all mocks
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { getTargetFormat } = await import("open-sse/services/provider.js");

function makeChatCoreOptions(overrides = {}) {
  return {
    body: {
      model: "unknown-provider/some-model",
      messages: [{ role: "user", content: "Hello" }],
      stream: false,
    },
    modelInfo: { provider: "unknown-provider", model: "some-model" },
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

describe("Passthrough error handling — chatCore target format failure (Task 2.5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsNativePassthrough.mockReturnValue(true);
    mockDetectClientTool.mockReturnValue("claude");
    executorReceivedBody = null;
    // getTargetFormat returns null — simulating provider format resolution failure
    getTargetFormat.mockReturnValue(null);
  });

  it("returns HTTP 400 error when target format cannot be resolved for passthrough provider", async () => {
    const result = await handleChatCore(makeChatCoreOptions());

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toContain("Unsupported provider target format");
  });

  it("does NOT call the executor when target format resolution fails", async () => {
    await handleChatCore(makeChatCoreOptions());
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("does NOT mutate the request body into a different format on resolution failure", async () => {
    const body = {
      model: "unknown-provider/some-model",
      messages: [{ role: "user", content: "Hello" }],
      stream: false,
      custom_field: "preserve-me",
    };
    const originalBody = JSON.parse(JSON.stringify(body));

    await handleChatCore(makeChatCoreOptions({ body }));

    // Body should not have been mutated by translation
    expect(body.custom_field).toBe(originalBody.custom_field);
    expect(body.messages).toEqual(originalBody.messages);
  });

  it("does NOT silently fall back to translated mode when passthrough format resolution fails", async () => {
    const { translateRequest } = await import("open-sse/translator/index.js");

    await handleChatCore(makeChatCoreOptions());

    // Translation should never have been attempted
    expect(translateRequest).not.toHaveBeenCalled();
  });

  it("includes provider and model in error message for debuggability", async () => {
    const result = await handleChatCore(makeChatCoreOptions({
      modelInfo: { provider: "bad-provider", model: "bad-model" },
    }));

    expect(result.error).toContain("bad-provider");
    expect(result.error).toContain("bad-model");
  });
});

describe("Passthrough error handling — passthrough detection does NOT guess provider (Task 2.5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executorReceivedBody = null;
    // Valid target format so we get past that check
    getTargetFormat.mockReturnValue("claude");
  });

  it("does NOT enable passthrough for unrecognized client tools — translation runs instead", async () => {
    // When client tool is unrecognized, passthrough should be false
    // The mock simulates: detectClientTool returns null → isNativePassthrough returns false
    mockDetectClientTool.mockReturnValue(null);
    mockIsNativePassthrough.mockReturnValue(false);

    const { translateRequest } = await import("open-sse/translator/index.js");

    await handleChatCore(makeChatCoreOptions({
      modelInfo: { provider: "claude", model: "claude-sonnet-4-20250514" },
    }));

    // Translation SHOULD run because passthrough is NOT active
    expect(translateRequest).toHaveBeenCalled();
  });

  it("does NOT enable passthrough when client tool doesn't match provider (cross-ecosystem) — translation runs", async () => {
    // e.g., Claude CLI sending to OpenAI — this is NOT passthrough
    mockDetectClientTool.mockReturnValue("claude");
    mockIsNativePassthrough.mockReturnValue(false);

    const { translateRequest } = await import("open-sse/translator/index.js");

    await handleChatCore(makeChatCoreOptions({
      modelInfo: { provider: "openai", model: "gpt-4o" },
    }));

    // Translation SHOULD run because passthrough is NOT active for cross-ecosystem
    expect(translateRequest).toHaveBeenCalled();
  });
});
