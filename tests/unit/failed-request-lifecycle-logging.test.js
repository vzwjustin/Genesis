import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  saveRequestDetail: vi.fn(() => Promise.resolve()),
  buildRequestDetail: vi.fn((base, overrides) => ({ ...base, ...overrides })),
}));

vi.mock("@/lib/usageDb.js", () => ({
  saveRequestDetail: (...args) => mocks.saveRequestDetail(...args),
  appendRequestLog: vi.fn(() => Promise.resolve()),
  trackPendingRequest: vi.fn(),
}));

vi.mock("open-sse/handlers/chatCore/requestDetail.js", () => ({
  buildRequestDetail: (...args) => mocks.buildRequestDetail(...args),
  extractRequestConfig: vi.fn(() => ({ stream: true })),
  saveUsageStats: vi.fn(),
}));

const { handleForcedSSEToJson } = await import("../../open-sse/handlers/chatCore/sseToJsonHandler.js");
const { FORMATS } = await import("../../open-sse/translator/formats.js");

const root = join(import.meta.dirname, "..", "..");

describe("failed request lifecycle logging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("finalizes forced-SSE assembly failures as failed request details", async () => {
    const appendLog = vi.fn(() => Promise.resolve());
    const trackDone = vi.fn();
    const providerResponse = new Response(
      "data: {\"id\":\"chunk-1\",\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n",
      { headers: { "content-type": "text/event-stream" } }
    );

    const result = await handleForcedSSEToJson({
      providerResponse,
      sourceFormat: FORMATS.OPENAI,
      targetFormat: FORMATS.OPENAI,
      provider: "openai",
      model: "gpt-4",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      translatedBody: { messages: [{ role: "user", content: "hi" }] },
      finalBody: null,
      requestStartTime: Date.now(),
      connectionId: "conn-1",
      apiKey: "key-1",
      clientRawRequest: { endpoint: "/v1/chat/completions" },
      onRequestSuccess: vi.fn(),
      trackDone,
      appendLog,
      passthrough: false,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(trackDone).toHaveBeenCalled();
    expect(appendLog).toHaveBeenCalledWith({ status: "FAILED 502" });
    expect(mocks.saveRequestDetail).toHaveBeenCalledTimes(1);
    expect(mocks.buildRequestDetail).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        response: expect.objectContaining({
          error: "Invalid SSE response for non-streaming request",
          status: 502,
        }),
      }),
      { endpoint: "/v1/chat/completions" }
    );
  });

  it("keeps forced-SSE failure persistence fail-open", async () => {
    mocks.saveRequestDetail.mockImplementationOnce(() => Promise.reject(new Error("db down")));
    const providerResponse = new Response("data: not-json\n\n", {
      headers: { "content-type": "text/event-stream" },
    });

    const result = await handleForcedSSEToJson({
      providerResponse,
      sourceFormat: FORMATS.OPENAI,
      targetFormat: FORMATS.OPENAI,
      provider: "openai",
      model: "gpt-4",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      translatedBody: { messages: [{ role: "user", content: "hi" }] },
      finalBody: null,
      requestStartTime: Date.now(),
      connectionId: "conn-1",
      apiKey: "key-1",
      clientRawRequest: { endpoint: "/v1/chat/completions" },
      onRequestSuccess: vi.fn(),
      trackDone: vi.fn(),
      appendLog: vi.fn(() => Promise.resolve()),
      passthrough: false,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
  });

  it("keeps token-refresh terminal error returns behind failed-request finalization", () => {
    const src = readFileSync(join(root, "open-sse/handlers/chatCore.js"), "utf8");

    expect(src).toContain("const finalizeFailedRequest = (message, status = HTTP_STATUS.BAD_GATEWAY)");
    expect(src).toContain("finalizeFailedRequest(message, providerResponse.status);\n      return createErrorResult(providerResponse.status, message);");
    expect(src).toContain("finalizeFailedRequest(`Retry after token refresh failed: ${retryError.message}`, HTTP_STATUS.BAD_GATEWAY);");
    expect(src.match(/finalizeFailedRequest\(message, providerResponse\.status\);/g)).toHaveLength(3);
  });

  it("keeps forced-SSE failure returns behind failed-request finalization", () => {
    const src = readFileSync(join(root, "open-sse/handlers/chatCore/sseToJsonHandler.js"), "utf8");

    expect(src).toContain("const finalizeFailure = (message, status = HTTP_STATUS.BAD_GATEWAY)");
    expect(src).toContain("finalizeFailure(\"Incomplete streaming response\");");
    expect(src).toContain("finalizeFailure(\"Invalid SSE response for non-streaming request\");");
    expect(src.match(/finalizeFailure\("Failed to convert streaming response to JSON"\);/g)).toHaveLength(2);
  });
});
