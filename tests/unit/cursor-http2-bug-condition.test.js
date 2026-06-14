/**
 * Bug Condition Exploration Test — Cursor HTTP/2 Fallback
 *
 * **Validates: Requirements 1.1, 1.2, 1.3, 1.4**
 *
 * This test encodes the EXPECTED (correct) behavior for Cursor requests under
 * degraded paths. On UNFIXED code, these tests FAIL — confirming the bug exists.
 *
 * Bug: Cursor's API (api2.cursor.sh) is HTTP/2-only (returns 464 on HTTP/1.1).
 * The executor and proxyFetch fallback paths silently downgrade to HTTP/1.1 when:
 *   1. DNS resolution fails → shouldForceFetch=true → makeFetchRequest (HTTP/1.1)
 *   2. Proxy configured → shouldForceFetch=true → makeFetchRequest (HTTP/1.1)
 *   3. Generic proxyFetch bypass → createBypassRequest (HTTP/1.1)
 *   4. DNS error swallowed by empty catch → no error propagated
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// We test the routing logic by examining what the executor calls under each condition.
// We mock the dependencies to isolate the decision logic.

// Mock proxyFetch module
vi.mock("../../open-sse/utils/proxyFetch.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    // Override resolveRealIP to simulate DNS failure
    resolveRealIP: vi.fn(),
    // Keep other functions real
    shouldBypassMitmDns: actual.shouldBypassMitmDns,
    hasApplicableEnvProxy: vi.fn(() => false),
    proxyAwareFetch: vi.fn(),
  };
});

// Mock cursorProtobuf to avoid needing real protobuf generation
vi.mock("../../open-sse/utils/cursorProtobuf.js", () => ({
  generateCursorBody: vi.fn(() => Buffer.from("mock-protobuf")),
  parseConnectRPCFrame: vi.fn(),
  extractTextFromResponse: vi.fn(() => ({ text: "test" })),
}));

// Mock cursorChecksum to avoid checksum computation
vi.mock("../../open-sse/utils/cursorChecksum.js", () => ({
  buildCursorHeaders: vi.fn(() => ({
    "content-type": "application/connect+proto",
    authorization: "Bearer test-token",
  })),
}));

// Mock cacheBoundary
vi.mock("../../open-sse/rtk/cacheBoundary.js", () => ({
  throwOnCacheViolation: vi.fn(),
}));

// Mock composerRedactedTools
vi.mock("../../open-sse/utils/composerRedactedTools.js", () => ({
  stripRedactedToolCalls: vi.fn((t) => t),
  extractRedactedToolCalls: vi.fn(() => []),
}));

import { resolveRealIP, hasApplicableEnvProxy, proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { CursorExecutor } from "../../open-sse/executors/cursor.js";

describe("Bug Condition: Cursor HTTP/1.1 Fallback on Degraded Paths", () => {
  let executor;

  const mockCredentials = {
    accessToken: "test-token",
    providerSpecificData: { machineId: "test-machine-id", ghostMode: true },
  };
  const mockBody = { messages: [{ role: "user", content: "hello" }] };

  beforeEach(() => {
    vi.clearAllMocks();
    executor = new CursorExecutor();
    // Spy on the executor's methods to observe routing decisions
    vi.spyOn(executor, "makeHttp2Request").mockResolvedValue({
      status: 200,
      headers: {},
      body: Buffer.from([0x00, 0x00, 0x00, 0x00, 0x05, 0x0a, 0x03, 0x68, 0x69, 0x21]),
    });
    vi.spyOn(executor, "makeFetchRequest").mockResolvedValue({
      status: 200,
      headers: {},
      body: Buffer.from([0x00, 0x00, 0x00, 0x00, 0x05, 0x0a, 0x03, 0x68, 0x69, 0x21]),
    });
    // Spy on makeHttp2ProxyRequest (HTTP/2-over-CONNECT tunnel for proxy case)
    if (typeof executor.makeHttp2ProxyRequest === "function") {
      vi.spyOn(executor, "makeHttp2ProxyRequest").mockResolvedValue({
        status: 200,
        headers: {},
        body: Buffer.from([0x00, 0x00, 0x00, 0x00, 0x05, 0x0a, 0x03, 0x68, 0x69, 0x21]),
      });
    }
  });

  it("Test case 1 (DNS fail): When resolveRealIP throws, should use HTTP/2 or throw descriptive error — NOT silently set shouldForceFetch=true", async () => {
    // Simulate DNS resolution failure (throws)
    resolveRealIP.mockRejectedValue(new Error("ENOTFOUND: DNS resolution failed"));
    hasApplicableEnvProxy.mockReturnValue(false);

    // Execute with no proxy configured
    const result = await executor.execute({
      model: "claude-3.5-sonnet",
      body: mockBody,
      stream: true,
      credentials: mockCredentials,
      signal: null,
      log: () => {},
      proxyOptions: null,
    });

    // EXPECTED (correct) behavior: Either makeHttp2Request is called (H2 transport)
    // OR the execute method throws a descriptive DNS error.
    // It should NOT silently route to makeFetchRequest (HTTP/1.1).
    const usedHttp2 = executor.makeHttp2Request.mock.calls.length > 0;
    const usedFetch = executor.makeFetchRequest.mock.calls.length > 0;
    const errorResponse = result?.response;

    if (usedFetch) {
      // BUG: makeFetchRequest was called — HTTP/1.1 fallback occurred
      // The expected behavior is HTTP/2 or a clear error, not HTTP/1.1
      expect(usedFetch).toBe(false); // This SHOULD fail on unfixed code
    } else if (!usedHttp2 && errorResponse) {
      // Acceptable: error response with DNS failure message
      const body = await errorResponse.text();
      expect(body).toContain("DNS");
    } else {
      // HTTP/2 was used — correct behavior
      expect(usedHttp2).toBe(true);
    }
  });

  it("Test case 2 (Proxy): When proxyOptions.enabled=true, should use HTTP/2-over-CONNECT — NOT HTTP/1.1 ProxyAgent via makeFetchRequest()", async () => {
    // Simulate proxy configured
    resolveRealIP.mockResolvedValue("1.2.3.4");
    hasApplicableEnvProxy.mockReturnValue(false);

    const result = await executor.execute({
      model: "claude-3.5-sonnet",
      body: mockBody,
      stream: true,
      credentials: mockCredentials,
      signal: null,
      log: () => {},
      proxyOptions: { enabled: true, url: "http://proxy.example.com:8080" },
    });

    // EXPECTED (correct) behavior: The system should use HTTP/2 transport through
    // a CONNECT tunnel, NOT route to makeFetchRequest which uses HTTP/1.1.
    const usedHttp2 = executor.makeHttp2Request.mock.calls.length > 0;
    const usedHttp2Proxy = typeof executor.makeHttp2ProxyRequest?.mock?.calls?.length === "number"
      && executor.makeHttp2ProxyRequest.mock.calls.length > 0;
    const usedFetch = executor.makeFetchRequest.mock.calls.length > 0;

    // On unfixed code: usingProxy=true → shouldForceFetch=true → makeFetchRequest called
    // Expected: HTTP/2-over-CONNECT (makeHttp2Request or makeHttp2ProxyRequest — h2 transport)
    expect(usedFetch).toBe(false); // SHOULD FAIL on unfixed code — confirms bug
    expect(usedHttp2 || usedHttp2Proxy).toBe(true);
  });

  it("Test case 3 (Generic proxyFetch): When _proxyAwareFetch handles api2.cursor.sh with DNS resolving, should use HTTP/2 — NOT createBypassRequest (HTTP/1.1)", async () => {
    // The proxyAwareFetch is the generic path. When it handles api2.cursor.sh,
    // it should use HTTP/2, not createBypassRequest (which is HTTP/1.1).
    // We test this by importing and examining the source behavior.
    
    // Import the actual module source to analyze its behavior
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const proxyFetchSrc = readFileSync(
      join(import.meta.dirname, "../../open-sse/utils/proxyFetch.js"),
      "utf8"
    );

    // Find the MITM bypass block in _proxyAwareFetch.
    // After resolveRealIP succeeds for api2.cursor.sh, the code should NOT call
    // createBypassRequest (HTTP/1.1) unconditionally. It should check if HTTP/2
    // is required and use an h2 session for Cursor.
    const proxyAwareFetchFn = proxyFetchSrc.match(
      /async function _proxyAwareFetch\b[\s\S]*?^}/m
    );
    expect(proxyAwareFetchFn).not.toBeNull();
    const bypassCode = proxyAwareFetchFn[0];

    // EXPECTED (correct) behavior: The _proxyAwareFetch function should check if HTTP/2 is
    // required for the host and use an h2 session for Cursor, not createBypassRequest.
    // On unfixed code: it always calls createBypassRequest regardless of host.
    const hasHttp2Awareness = bypassCode.includes("isHttp2Required")
      || bypassCode.includes("Http2Bypass")
      || bypassCode.includes("createHttp2");

    // This SHOULD FAIL on unfixed code — createBypassRequest is HTTP/1.1 for ALL hosts
    expect(hasHttp2Awareness).toBe(true);
  });

  it("Test case 4 (Silent catch): When resolveRealIP throws, error should be propagated — NOT swallowed by empty catch", async () => {
    // Examine the cursor executor source to verify error handling behavior
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const cursorSrc = readFileSync(
      join(import.meta.dirname, "../../open-sse/executors/cursor.js"),
      "utf8"
    );

    // Find the DNS resolution block in execute()
    // On unfixed code: `try { bypassIP = await resolveRealIP(...) } catch { bypassIP = null; }`
    // Expected: error should be propagated (thrown or handled explicitly), NOT swallowed
    const hasSilentCatch = /try\s*\{[^}]*resolveRealIP[^}]*\}\s*catch\s*(\([^)]*\))?\s*\{\s*\n?\s*bypassIP\s*=\s*null;?\s*\n?\s*\}/.test(cursorSrc);

    // If the catch block just sets bypassIP = null without propagating the error,
    // that's the bug — DNS failures are silently swallowed.
    // EXPECTED: no silent catch — error should be thrown or logged+rethrown for Cursor
    expect(hasSilentCatch).toBe(false); // SHOULD FAIL on unfixed code
  });
});
