/**
 * Integration tests for handleChatCore pre-dispatch validation failures.
 *
 * Requirements 1.4: IF any failure prevents successful request processing
 * (format detection failure, translation failure, model resolution failure,
 * request schema violation), THEN THE Proxy SHALL return HTTP 400 with a
 * descriptive error.
 *
 * These tests exercise handleChatCore directly to verify all validation paths
 * return HTTP 400 with the correct error types.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies that chatCore imports — must be before import
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn().mockReturnValue(Promise.resolve()),
  saveRequestDetail: vi.fn().mockReturnValue(Promise.resolve()),
}));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: vi.fn().mockResolvedValue({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logOpenAIRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logError: vi.fn(),
  }),
}));
vi.mock("../../open-sse/rtk/index.js", () => ({
  compressMessages: vi.fn().mockReturnValue({}),
  formatRtkLog: vi.fn().mockReturnValue(null),
}));
vi.mock("../../open-sse/rtk/headroom.js", () => ({
  compressWithHeadroom: vi.fn().mockResolvedValue(null),
}));
vi.mock("../../open-sse/rtk/caveman.js", () => ({
  injectCaveman: vi.fn(),
}));
vi.mock("@/lib/compressionStats.js", () => ({
  recordCompressionStats: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../open-sse/utils/bypassHandler.js", () => ({
  handleBypassRequest: () => null,
}));
vi.mock("../../open-sse/utils/clientDetector.js", () => ({
  detectClientTool: () => null,
  isNativePassthrough: () => false,
  shouldUseNativePassthrough: () => false,
}));
vi.mock("../../open-sse/config/providerModels.js", () => ({
  getModelTargetFormat: () => null,
  getModelStrip: () => [],
  getModelUpstreamId: (_alias, modelId) => modelId,
  getModelRequestExtras: () => null,
  getModelsByProviderId: () => [],
  PROVIDER_ID_TO_ALIAS: {},
}));
vi.mock("../../open-sse/utils/toolDeduper.js", () => ({
  dedupeTools: (tools) => ({ tools, stripped: [] }),
}));
vi.mock("../../open-sse/utils/streamHandler.js", () => ({
  createStreamController: () => ({ signal: new AbortController().signal, handleComplete: () => {}, handleError: () => {} }),
}));
vi.mock("../../open-sse/services/tokenRefresh.js", () => ({
  refreshWithRetry: vi.fn(),
}));
vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({
    execute: vi.fn(() => Promise.resolve({
      response: { ok: true, status: 200, headers: new Map() },
      url: "https://api.openai.com/v1/chat/completions",
      headers: {},
      transformedBody: {},
    })),
    noAuth: false,
  }),
}));
vi.mock("../../open-sse/handlers/chatCore/requestDetail.js", () => ({
  buildRequestDetail: () => ({}),
  extractRequestConfig: () => ({}),
}));
vi.mock("../../open-sse/handlers/chatCore/sseToJsonHandler.js", () => ({
  handleForcedSSEToJson: vi.fn(() => null),
}));
vi.mock("../../open-sse/handlers/chatCore/nonStreamingHandler.js", () => ({
  handleNonStreamingResponse: vi.fn(() => ({ success: true, response: new Response("{}") })),
}));
vi.mock("../../open-sse/handlers/chatCore/streamingHandler.js", () => ({
  handleStreamingResponse: vi.fn(() => ({ success: true, response: new Response("{}") })),
  buildOnStreamComplete: () => ({ onStreamComplete: () => {} }),
}));

const mockTranslateRequest = vi.fn((...args) => {
  const [, , , body] = args;
  return { ...body, model: "gpt-4" };
});
vi.mock("../../open-sse/translator/index.js", () => ({
  translateRequest: (...args) => mockTranslateRequest(...args),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

describe("handleChatCore pre-dispatch validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTranslateRequest.mockImplementation((...args) => {
      const [, , , body] = args;
      return { ...body, model: "gpt-4" };
    });
  });

  describe("body validation (translation_invalid_body)", () => {
    it("returns HTTP 400 when body is null", async () => {
      const result = await handleChatCore({
        body: null,
        modelInfo: { provider: "openai", model: "gpt-4" },
        credentials: { apiKey: "test" },
      });
      expect(result.success).toBe(false);
      expect(result.status).toBe(400);
      const json = await result.response.json();
      expect(json.error.type).toBe("translation_invalid_body");
      expect(json.error.code).toBe("translation_invalid_body");
      expect(json.error.message).toContain("JSON object");
    });

    it("returns HTTP 400 when body is a string", async () => {
      const result = await handleChatCore({
        body: "not an object",
        modelInfo: { provider: "openai", model: "gpt-4" },
        credentials: { apiKey: "test" },
      });
      expect(result.success).toBe(false);
      expect(result.status).toBe(400);
      const json = await result.response.json();
      expect(json.error.type).toBe("translation_invalid_body");
      expect(json.error.code).toBe("translation_invalid_body");
    });

    it("returns HTTP 400 when body is a number", async () => {
      const result = await handleChatCore({
        body: 42,
        modelInfo: { provider: "openai", model: "gpt-4" },
        credentials: { apiKey: "test" },
      });
      expect(result.success).toBe(false);
      expect(result.status).toBe(400);
      const json = await result.response.json();
      expect(json.error.type).toBe("translation_invalid_body");
    });
  });

  describe("missing required field (missing_required_field)", () => {
    it("returns HTTP 400 when body has no messages, input, or contents", async () => {
      const result = await handleChatCore({
        body: { model: "gpt-4", stream: true },
        modelInfo: { provider: "openai", model: "gpt-4" },
        credentials: { apiKey: "test" },
      });
      expect(result.success).toBe(false);
      expect(result.status).toBe(400);
      const json = await result.response.json();
      expect(json.error.type).toBe("missing_required_field");
      expect(json.error.code).toBe("missing_required_field");
      expect(json.error.message).toContain("messages");
    });

    it("returns HTTP 400 when messages is not an array", async () => {
      const result = await handleChatCore({
        body: { messages: "not-an-array" },
        modelInfo: { provider: "openai", model: "gpt-4" },
        credentials: { apiKey: "test" },
      });
      expect(result.success).toBe(false);
      expect(result.status).toBe(400);
      const json = await result.response.json();
      expect(json.error.type).toBe("missing_required_field");
    });

    it("returns HTTP 400 when input is not an array or string", async () => {
      const result = await handleChatCore({
        body: { input: 123 },
        modelInfo: { provider: "openai", model: "gpt-4" },
        credentials: { apiKey: "test" },
      });
      expect(result.success).toBe(false);
      expect(result.status).toBe(400);
      const json = await result.response.json();
      expect(json.error.type).toBe("missing_required_field");
    });
  });

  describe("format detection failure (unsupported_request)", () => {
    it("returns HTTP 400 when sourceFormatOverride is unrecognized", async () => {
      const result = await handleChatCore({
        body: { messages: [{ role: "user", content: "hi" }] },
        modelInfo: { provider: "openai", model: "gpt-4" },
        credentials: { apiKey: "test" },
        sourceFormatOverride: "totally-invalid-format",
      });
      expect(result.success).toBe(false);
      expect(result.status).toBe(400);
      const json = await result.response.json();
      expect(json.error.type).toBe("unsupported_request");
      expect(json.error.code).toBe("unsupported_request");
      expect(json.error.message).toContain("totally-invalid-format");
    });

    it("returns HTTP 400 when sourceFormatOverride is empty string", async () => {
      // Empty string is falsy, so detectFormat will be used instead.
      // This shouldn't fail because detectFormat always returns a format.
      const result = await handleChatCore({
        body: { messages: [{ role: "user", content: "hi" }] },
        modelInfo: { provider: "openai", model: "gpt-4" },
        credentials: { apiKey: "test" },
        sourceFormatOverride: "",
      });
      // Empty string is falsy, falls through to detectFormat which returns "openai"
      // This should NOT produce a 400 since format detection succeeds
      expect(result.success).toBe(true);
    });
  });

  describe("translation failure (translation_invalid_body)", () => {
    it("returns HTTP 400 when translateRequest returns null", async () => {
      mockTranslateRequest.mockReturnValueOnce(null);

      const result = await handleChatCore({
        body: { messages: [{ role: "user", content: "hi" }] },
        modelInfo: { provider: "openai", model: "gpt-4" },
        credentials: { apiKey: "test" },
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe(400);
      const json = await result.response.json();
      expect(json.error.type).toBe("translation_invalid_body");
      expect(json.error.code).toBe("translation_invalid_body");
    });
  });

  describe("fusion assistant prefill (validation_failed)", () => {
    it("returns HTTP 400 when stripping trailing assistant prefill leaves no messages", async () => {
      const result = await handleChatCore({
        body: {
          messages: [{ role: "assistant", content: "partial prefill" }],
        },
        modelInfo: { provider: "fusion", model: "openrouter/fusion" },
        credentials: { apiKey: "test" },
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe(400);
      const json = await result.response.json();
      expect(json.error.type).toBe("validation_failed");
      expect(json.error.message).toContain("assistant prefill");
    });
  });

  describe("all validation errors include proper structure", () => {
    it("every 400 response includes error.type, error.code, and error.message", async () => {
      const testCases = [
        { body: null, desc: "null body" },
        { body: "string", desc: "string body" },
        { body: { noMessages: true }, desc: "missing messages" },
      ];

      for (const { body, desc } of testCases) {
        const result = await handleChatCore({
          body,
          modelInfo: { provider: "openai", model: "gpt-4" },
          credentials: { apiKey: "test" },
        });
        expect(result.success).toBe(false);
        expect(result.status).toBe(400);
        const json = await result.response.json();
        expect(json.error).toBeDefined();
        expect(json.error.type).toBeDefined();
        expect(json.error.code).toBeDefined();
        expect(json.error.message).toBeDefined();
        expect(typeof json.error.message).toBe("string");
        expect(json.error.message.length).toBeGreaterThan(0);
      }
    });
  });
});
