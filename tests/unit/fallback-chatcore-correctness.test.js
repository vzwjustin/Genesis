/**
 * Account fallback + chatCore correctness fixes:
 * - Proxy-internal 502s must not rotate accounts
 * - No-auth maxRetries uses connection count
 * - Pre-flight skips must not consume retry slots
 * - Passthrough non-streaming validates shape before onRequestSuccess
 * - Compression restore failure fails closed
 * - Token refresh retry uses merged upstream signal
 * - Client abort (499) does not mark account unavailable
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";
import {
  PROXY_INTERNAL_ERROR_CODES,
  isProxyInternalError,
  createErrorResult,
} from "../../open-sse/utils/error.js";
import { handleNonStreamingResponse } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";

const root = dirname(fileURLToPath(import.meta.url));

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn().mockResolvedValue(undefined),
  saveRequestDetail: vi.fn().mockResolvedValue(undefined),
}));

describe("checkFallbackError — proxy-internal errors", () => {
  it("does not rotate on proxy-internal 502 with sse_assembly_failed", () => {
    const result = checkFallbackError(502, "Invalid SSE response", 0, {
      proxyInternal: true,
      errorCode: PROXY_INTERNAL_ERROR_CODES.SSE_ASSEMBLY_FAILED,
    });
    expect(result.shouldFallback).toBe(false);
    expect(result.cooldownMs).toBe(0);
  });

  it("does not rotate on proxy-internal via errorCode alone", () => {
    const result = checkFallbackError(502, "parse failed", 0, {
      errorCode: PROXY_INTERNAL_ERROR_CODES.RESPONSE_PARSE_FAILED,
    });
    expect(result.shouldFallback).toBe(false);
  });

  it("still rotates on upstream 502 without proxy-internal flag", () => {
    const result = checkFallbackError(502, "Bad gateway from provider", 0);
    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBe(30_000);
  });

  it("still rotates on 429 rate limits", () => {
    const result = checkFallbackError(429, "", 0);
    expect(result.shouldFallback).toBe(true);
    expect(result.newBackoffLevel).toBe(1);
  });
});

describe("createErrorResult — proxy-internal metadata", () => {
  it("sets proxyInternal when errorCode is proxy-internal", () => {
    const result = createErrorResult(502, "assembly failed", undefined, {
      errorCode: PROXY_INTERNAL_ERROR_CODES.SSE_ASSEMBLY_FAILED,
    });
    expect(result.proxyInternal).toBe(true);
    expect(result.errorCode).toBe("sse_assembly_failed");
  });

  it("isProxyInternalError recognizes explicit flag", () => {
    expect(isProxyInternalError({ proxyInternal: true })).toBe(true);
    expect(isProxyInternalError({ errorCode: "proxy_internal" })).toBe(true);
    expect(isProxyInternalError({})).toBe(false);
  });
});

describe("resolveProviderRetryLimits — no-auth uses connection count", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("uses allConnections.length for no-auth providers", async () => {
    vi.doMock("@/lib/localDb", () => ({
      getProviderConnections: vi.fn().mockResolvedValue([
        { id: "a" },
        { id: "b" },
        { id: "c" },
      ]),
    }));
    vi.doMock("@/shared/constants/providers.js", () => ({
      resolveProviderId: (p) => p,
      FREE_PROVIDERS: { searxng: { noAuth: true } },
    }));

    const { resolveProviderRetryLimits } = await import("../../src/sse/utils/providerCredentialRetry.js");
    const { maxRetries, isNoAuthProvider } = await resolveProviderRetryLimits("searxng");
    expect(isNoAuthProvider).toBe(true);
    expect(maxRetries).toBe(3);
  });
});

describe("chat handler — pre-flight skips do not consume retry slots", () => {
  const src = readFileSync(join(root, "../../src/sse/handlers/chat.js"), "utf8");

  it("increments retryCount after token refresh and projectId pre-checks", () => {
    const tokenRefreshIdx = src.indexOf("_tokenRefreshFailed");
    const projectIdIdx = src.indexOf("Antigravity missing projectId");
    const retryIncIdx = src.indexOf("retryCount++");
    expect(tokenRefreshIdx).toBeGreaterThan(-1);
    expect(projectIdIdx).toBeGreaterThan(-1);
    expect(retryIncIdx).toBeGreaterThan(tokenRefreshIdx);
    expect(retryIncIdx).toBeGreaterThan(projectIdIdx);
  });

  it("passes proxy-internal metadata to markAccountUnavailable", () => {
    expect(src).toContain("proxyInternal: result.proxyInternal");
    expect(src).toContain("errorCode: result.errorCode");
  });

  it("returns client aborts before markAccountUnavailable", () => {
    const abortIdx = src.indexOf("if (result.status === 499)");
    const markIdx = src.indexOf("markAccountUnavailable(");
    expect(abortIdx).toBeGreaterThan(-1);
    expect(markIdx).toBeGreaterThan(-1);
    expect(abortIdx).toBeLessThan(markIdx);
  });
});

describe("non-chat handlers — client aborts do not mark accounts unavailable", () => {
  const files = [
    "src/sse/handlers/embeddings.js",
    "src/sse/handlers/imageGeneration.js",
    "src/sse/handlers/tts.js",
    "src/sse/handlers/stt.js",
    "src/sse/handlers/search.js",
    "src/sse/handlers/fetch.js",
  ];

  for (const rel of files) {
    it(`${rel} returns 499 before markAccountUnavailable`, () => {
      const src = readFileSync(join(root, "../..", rel), "utf8");
      const abortIdx = src.indexOf("result.status === 499");
      const markIdx = src.indexOf("markAccountUnavailable(");
      expect(abortIdx).toBeGreaterThan(-1);
      expect(markIdx).toBeGreaterThan(-1);
      expect(abortIdx).toBeLessThan(markIdx);
    });
  }
});

describe("media cores — aborts preserve 499", () => {
  for (const rel of ["open-sse/handlers/ttsCore.js", "open-sse/handlers/sttCore.js"]) {
    it(`${rel} maps AbortError to 499`, () => {
      const src = readFileSync(join(root, "../..", rel), "utf8");
      const abortIdx = src.indexOf('err?.name === "AbortError"');
      const statusIdx = src.indexOf('createErrorResult(499, "Request aborted")');
      const badGatewayIdx = src.indexOf("HTTP_STATUS.BAD_GATEWAY", abortIdx);
      expect(abortIdx).toBeGreaterThan(-1);
      expect(statusIdx).toBeGreaterThan(abortIdx);
      expect(statusIdx).toBeLessThan(badGatewayIdx);
    });
  }
});

describe("nonStreamingHandler — passthrough validates before onRequestSuccess", () => {
  const baseCtx = {
    provider: "claude",
    model: "claude-sonnet",
    sourceFormat: "claude",
    targetFormat: "claude",
    body: { messages: [{ role: "user", content: "Hi" }] },
    stream: false,
    translatedBody: {},
    finalBody: null,
    requestStartTime: Date.now(),
    connectionId: "conn-1",
    apiKey: "key",
    clientRawRequest: { headers: {}, body: "{}", endpoint: "/v1/messages" },
    reqLogger: { logProviderResponse: vi.fn(), logConvertedResponse: vi.fn() },
    toolNameMap: null,
    trackDone: vi.fn(),
    appendLog: vi.fn(),
    passthrough: true,
  };

  it("rejects empty passthrough JSON without calling onRequestSuccess", async () => {
    const onRequestSuccess = vi.fn();
    const result = await handleNonStreamingResponse({
      ...baseCtx,
      onRequestSuccess,
      providerResponse: {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Map([["content-type", "application/json"]]),
        json: () => Promise.resolve({ id: "empty" }),
      },
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(result.proxyInternal).toBe(true);
    expect(onRequestSuccess).not.toHaveBeenCalled();
  });
});

describe("chatCore — compression restore and token refresh (source)", () => {
  const src = readFileSync(join(root, "../../open-sse/handlers/chatCore.js"), "utf8");

  it("fails closed when compression body restore throws", () => {
    expect(src).toContain("COMPRESSION_RESTORE_FAILED");
    expect(src).toContain("could not be restored");
  });

  it("token refresh retry uses upstreamSignal not streamController.signal only", () => {
    expect(src).toContain("signal: upstreamSignal");
    expect(src).not.toMatch(/retryResult = await executor\.execute\([\s\S]*signal: streamController\.signal/);
  });
});
