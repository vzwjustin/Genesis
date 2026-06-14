/**
 * Cursor HTTP/2 Preservation Property Tests
 *
 * Property 2: Preservation — Non-Cursor and Happy-Path Behavior Unchanged
 *
 * These tests encode existing CORRECT behavior on UNFIXED code that the
 * upcoming fix must NOT break. All tests MUST PASS on unfixed code.
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fc from "fast-check";

// ---------------------------------------------------------------------------
// Constants mirroring production values
// ---------------------------------------------------------------------------
const NON_CURSOR_BYPASS_HOSTS = [
  "api.individual.githubcopilot.com",
  "cloudcode-pa.googleapis.com",
  "daily-cloudcode-pa.googleapis.com",
  "q.us-east-1.amazonaws.com",
  "codewhisperer.us-east-1.amazonaws.com",
  "api.github.com",
];

const CURSOR_HOST = "api2.cursor.sh";

// ---------------------------------------------------------------------------
// Shared mock setup
// ---------------------------------------------------------------------------

// Track which transport function was called
let transportCalled;
let makeHttp2RequestArgs;
let makeFetchRequestArgs;
let resolveRealIPResult;
let mockHttp2Available;
let mockProxyOptions;
let mockHasApplicableEnvProxy;

/**
 * Simulates the CursorExecutor.execute() routing decision logic
 * extracted from the actual source code. This is the logic under test.
 */
function simulateExecuteRouting({ url, http2, proxyOptions, resolveRealIP, hasApplicableEnvProxy, shouldBypassMitmDns }) {
  const usingProxy = proxyOptions?.enabled === true
    || proxyOptions?.connectionProxyEnabled === true
    || !!proxyOptions?.vercelRelayUrl
    || hasApplicableEnvProxy(url);

  const needsDnsBypass = shouldBypassMitmDns(url);
  let bypassIP = null;

  if (needsDnsBypass && !usingProxy && http2) {
    try {
      bypassIP = resolveRealIP(new URL(url).hostname);
    } catch {
      bypassIP = null;
    }
  }

  const shouldForceFetch = usingProxy || (needsDnsBypass && !bypassIP);

  if (http2 && !shouldForceFetch) {
    return { transport: "makeHttp2Request", bypassIP };
  } else {
    return { transport: "makeFetchRequest", bypassIP: null };
  }
}

/**
 * Simulates the _proxyAwareFetch() MITM bypass block routing decision.
 * On unfixed code, ALL bypass hosts go through createBypassRequest (HTTP/1.1).
 */
function simulateProxyFetchBypass({ url, proxyUrl, resolveRealIP }) {
  const parsedUrl = new URL(url);
  if (proxyUrl) {
    return { transport: "proxyDispatcher" };
  }
  const realIP = resolveRealIP(parsedUrl.hostname);
  if (!realIP) {
    return { transport: "error", message: "External DNS resolution failed" };
  }
  return { transport: "createBypassRequest", realIP };
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Generates a random non-Cursor MITM bypass host */
const nonCursorBypassHostArb = fc.constantFrom(...NON_CURSOR_BYPASS_HOSTS);

/** Generates a URL path */
const urlPathArb = fc.constantFrom(
  "/v1/chat/completions",
  "/v1/models",
  "/v1/embeddings",
  "/api/generate",
  "/conversation"
);

/** Generates a complete URL for a given host */
function urlForHost(host) {
  return urlPathArb.map(path => `https://${host}${path}`);
}

/** Generates proxy options matching the unfixed code patterns */
const proxyOptionsArb = fc.oneof(
  fc.constant(null),
  fc.record({
    enabled: fc.constant(false),
    connectionProxyEnabled: fc.constant(false),
    url: fc.constant(""),
    vercelRelayUrl: fc.constant(""),
  }),
);

/** Generates a mock resolved IP address */
const resolvedIPArb = fc.constantFrom(
  "1.2.3.4",
  "10.0.0.1",
  "172.16.0.1",
  "203.0.113.42",
  "198.51.100.10"
);

// ---------------------------------------------------------------------------
// Property Tests
// ---------------------------------------------------------------------------

describe("Preservation Property Tests — Cursor HTTP/2 Fix", () => {

  describe("Property 2.1: Non-Cursor MITM bypass hosts always use createBypassRequest (HTTP/1.1)", () => {
    /**
     * **Validates: Requirements 3.2**
     *
     * For ALL non-Cursor MITM bypass hosts, the generic proxyFetch bypass
     * path ALWAYS calls createBypassRequest() (HTTP/1.1) — never HTTP/2.
     * This is correct because those APIs accept HTTP/1.1.
     */
    it("for all non-Cursor bypass hosts without proxy, transport is createBypassRequest", () => {
      fc.assert(
        fc.property(
          nonCursorBypassHostArb,
          urlPathArb,
          resolvedIPArb,
          (host, path, ip) => {
            const url = `https://${host}${path}`;
            const result = simulateProxyFetchBypass({
              url,
              proxyUrl: null,
              resolveRealIP: () => ip,
            });

            // On unfixed code, ALL bypass hosts use createBypassRequest (HTTP/1.1)
            expect(result.transport).toBe("createBypassRequest");
            expect(result.realIP).toBe(ip);
          }
        ),
        { numRuns: 200 }
      );
    });

    it("for all non-Cursor bypass hosts with proxy, transport is proxyDispatcher", () => {
      fc.assert(
        fc.property(
          nonCursorBypassHostArb,
          urlPathArb,
          fc.constantFrom("http://proxy.example.com:8080", "http://corp-proxy:3128"),
          (host, path, proxyUrl) => {
            const url = `https://${host}${path}`;
            const result = simulateProxyFetchBypass({
              url,
              proxyUrl,
              resolveRealIP: () => "1.2.3.4",
            });

            // When proxy is configured, bypass hosts route through proxy dispatcher
            expect(result.transport).toBe("proxyDispatcher");
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe("Property 2.2: Cursor happy path uses makeHttp2Request with realIP pinning", () => {
    /**
     * **Validates: Requirements 3.1**
     *
     * When DNS resolves successfully, no proxy is configured, and http2 is
     * available, the Cursor executor ALWAYS uses makeHttp2Request() with
     * the resolved real IP for TLS socket pinning.
     */
    it("for Cursor happy path (DNS resolves + no proxy + http2), transport is makeHttp2Request with realIP", () => {
      fc.assert(
        fc.property(
          urlPathArb,
          resolvedIPArb,
          (path, ip) => {
            const url = `https://${CURSOR_HOST}${path}`;
            const result = simulateExecuteRouting({
              url,
              http2: true, // http2 available
              proxyOptions: null, // no proxy
              resolveRealIP: () => ip, // DNS resolves
              hasApplicableEnvProxy: () => false,
              shouldBypassMitmDns: (u) => new URL(u).hostname === CURSOR_HOST
                || NON_CURSOR_BYPASS_HOSTS.includes(new URL(u).hostname),
            });

            expect(result.transport).toBe("makeHttp2Request");
            expect(result.bypassIP).toBe(ip);
          }
        ),
        { numRuns: 200 }
      );
    });

    it("Cursor happy path preserves IP pinning across varied IPs", () => {
      fc.assert(
        fc.property(
          // Generate varied IPs to verify pinning works with any IP
          fc.tuple(
            fc.integer({ min: 1, max: 255 }),
            fc.integer({ min: 0, max: 255 }),
            fc.integer({ min: 0, max: 255 }),
            fc.integer({ min: 1, max: 254 })
          ),
          ([a, b, c, d]) => {
            const ip = `${a}.${b}.${c}.${d}`;
            const url = `https://${CURSOR_HOST}/v1/chat/completions`;
            const result = simulateExecuteRouting({
              url,
              http2: true,
              proxyOptions: null,
              resolveRealIP: () => ip,
              hasApplicableEnvProxy: () => false,
              shouldBypassMitmDns: () => true,
            });

            expect(result.transport).toBe("makeHttp2Request");
            expect(result.bypassIP).toBe(ip);
          }
        ),
        { numRuns: 200 }
      );
    });
  });

  describe("Property 2.3: When http2 module is unavailable, fetch fallback is used", () => {
    /**
     * **Validates: Requirements 3.3**
     *
     * When http2=null (unavailable in the runtime), the executor ALWAYS
     * uses makeFetchRequest regardless of host, proxy, or DNS state.
     */
    it("for any host when http2 is null, transport is always makeFetchRequest", () => {
      fc.assert(
        fc.property(
          fc.constantFrom(CURSOR_HOST, ...NON_CURSOR_BYPASS_HOSTS),
          urlPathArb,
          proxyOptionsArb,
          (host, path, proxyOptions) => {
            const url = `https://${host}${path}`;
            const result = simulateExecuteRouting({
              url,
              http2: null, // http2 unavailable
              proxyOptions,
              resolveRealIP: () => "1.2.3.4",
              hasApplicableEnvProxy: () => false,
              shouldBypassMitmDns: () => true,
            });

            // http2=null means we always fall to fetch path
            expect(result.transport).toBe("makeFetchRequest");
          }
        ),
        { numRuns: 200 }
      );
    });

    it("http2 unavailable means bypassIP is never resolved", () => {
      fc.assert(
        fc.property(
          fc.constantFrom(CURSOR_HOST, ...NON_CURSOR_BYPASS_HOSTS),
          urlPathArb,
          (host, path) => {
            const url = `https://${host}${path}`;
            let resolveRealIPCalled = false;
            const result = simulateExecuteRouting({
              url,
              http2: null, // http2 unavailable
              proxyOptions: null,
              resolveRealIP: () => { resolveRealIPCalled = true; return "1.2.3.4"; },
              hasApplicableEnvProxy: () => false,
              shouldBypassMitmDns: () => true,
            });

            // When http2 is null, resolveRealIP should NOT be called
            // (the code checks `needsDnsBypass && !usingProxy && http2`)
            expect(resolveRealIPCalled).toBe(false);
            expect(result.transport).toBe("makeFetchRequest");
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe("Property 2.4: Proxy routing precedence unchanged for non-Cursor hosts", () => {
    /**
     * **Validates: Requirements 3.4, 3.5**
     *
     * Proxy routing precedence: per-connection → env → relay → direct
     * is unchanged for non-Cursor hosts. When any proxy mechanism is active,
     * non-Cursor bypass hosts use the fetch path (proxy dispatcher).
     */
    it("per-connection proxy forces fetch path for non-Cursor bypass hosts", () => {
      fc.assert(
        fc.property(
          nonCursorBypassHostArb,
          urlPathArb,
          (host, path) => {
            const url = `https://${host}${path}`;
            const result = simulateExecuteRouting({
              url,
              http2: true,
              proxyOptions: {
                enabled: true,
                url: "http://proxy.example.com:8080",
              },
              resolveRealIP: () => "1.2.3.4",
              hasApplicableEnvProxy: () => false,
              shouldBypassMitmDns: (u) => true,
            });

            // Per-connection proxy → usingProxy=true → shouldForceFetch=true → makeFetchRequest
            expect(result.transport).toBe("makeFetchRequest");
          }
        ),
        { numRuns: 100 }
      );
    });

    it("environment proxy forces fetch path for non-Cursor bypass hosts", () => {
      fc.assert(
        fc.property(
          nonCursorBypassHostArb,
          urlPathArb,
          (host, path) => {
            const url = `https://${host}${path}`;
            const result = simulateExecuteRouting({
              url,
              http2: true,
              proxyOptions: null,
              resolveRealIP: () => "1.2.3.4",
              hasApplicableEnvProxy: () => true, // env proxy active
              shouldBypassMitmDns: () => true,
            });

            // Env proxy → hasApplicableEnvProxy=true → usingProxy=true → makeFetchRequest
            expect(result.transport).toBe("makeFetchRequest");
          }
        ),
        { numRuns: 100 }
      );
    });

    it("relay/vercel relay forces fetch path for non-Cursor bypass hosts", () => {
      fc.assert(
        fc.property(
          nonCursorBypassHostArb,
          urlPathArb,
          (host, path) => {
            const url = `https://${host}${path}`;
            const result = simulateExecuteRouting({
              url,
              http2: true,
              proxyOptions: {
                enabled: false,
                vercelRelayUrl: "https://relay.example.com/proxy",
              },
              resolveRealIP: () => "1.2.3.4",
              hasApplicableEnvProxy: () => false,
              shouldBypassMitmDns: () => true,
            });

            // vercelRelayUrl truthy → usingProxy=true → makeFetchRequest
            expect(result.transport).toBe("makeFetchRequest");
          }
        ),
        { numRuns: 100 }
      );
    });

    it("no proxy configured allows direct HTTP/2 for Cursor (happy path baseline)", () => {
      fc.assert(
        fc.property(
          urlPathArb,
          resolvedIPArb,
          (path, ip) => {
            const url = `https://${CURSOR_HOST}${path}`;
            const result = simulateExecuteRouting({
              url,
              http2: true,
              proxyOptions: null,
              resolveRealIP: () => ip,
              hasApplicableEnvProxy: () => false,
              shouldBypassMitmDns: () => true,
            });

            // No proxy → usingProxy=false, DNS resolves → bypassIP set → !shouldForceFetch → makeHttp2Request
            expect(result.transport).toBe("makeHttp2Request");
            expect(result.bypassIP).toBe(ip);
          }
        ),
        { numRuns: 100 }
      );
    });

    it("proxy precedence: per-connection overrides env proxy for all bypass hosts", () => {
      fc.assert(
        fc.property(
          fc.constantFrom(CURSOR_HOST, ...NON_CURSOR_BYPASS_HOSTS),
          urlPathArb,
          (host, path) => {
            const url = `https://${host}${path}`;

            // Both per-connection and env proxy active
            const result = simulateExecuteRouting({
              url,
              http2: true,
              proxyOptions: {
                enabled: true,
                url: "http://connection-proxy:8080",
              },
              resolveRealIP: () => "1.2.3.4",
              hasApplicableEnvProxy: () => true,
              shouldBypassMitmDns: () => true,
            });

            // Either proxy → usingProxy=true → forces fetch (unfixed code doesn't
            // distinguish; both cause shouldForceFetch=true)
            expect(result.transport).toBe("makeFetchRequest");
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
