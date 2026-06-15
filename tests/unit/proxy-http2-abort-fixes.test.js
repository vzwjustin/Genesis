/**
 * Regression tests for the proxy / HTTP-2 tunnel / abort-propagation bug fixes.
 *
 * Covers:
 *  - cursor.js makeHttp2ProxyRequest: Proxy-Authorization for authed proxies,
 *    TLS-to-proxy for https proxies, malformed/non-200 CONNECT handling.
 *  - cursor.js execute() routing: relay-only config takes the fetch path, not
 *    the CONNECT tunnel; connect-proxy + Cursor takes the tunnel.
 *  - proxyFetch.js hostnameMatchesMitmBypass: exact-host match only (SSRF).
 *  - grok-web / perplexity-web / antigravity: AbortError propagates, not masked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import net from "node:net";

// cursor.js resolves tls via `await import("tls")` (a namespace), so spying the
// default import wouldn't attach. Mock the module so the dynamic import is
// intercepted with a controllable connect() spy.
vi.mock("tls", () => {
  const connect = vi.fn();
  return { default: { connect }, connect };
});

// ── Shared mocks for the cursor executor ──────────────────────────────────
vi.mock("../../open-sse/utils/cursorProtobuf.js", () => ({
  generateCursorBody: vi.fn(() => Buffer.from("mock-protobuf")),
  parseConnectRPCFrame: vi.fn(),
  extractTextFromResponse: vi.fn(() => ({ text: "test" })),
}));
vi.mock("../../open-sse/utils/cursorChecksum.js", () => ({
  buildCursorHeaders: vi.fn(() => ({
    "content-type": "application/connect+proto",
    authorization: "Bearer test-token",
  })),
}));
vi.mock("../../open-sse/rtk/cacheBoundary.js", () => ({
  throwOnCacheViolation: vi.fn(),
}));
vi.mock("../../open-sse/utils/composerRedactedTools.js", () => ({
  stripRedactedToolCalls: vi.fn((t) => t),
  extractRedactedToolCalls: vi.fn(() => []),
}));

describe("hostnameMatchesMitmBypass — exact host only (SSRF)", () => {
  it("matches exact bypass hosts but rejects attacker subdomains", async () => {
    const { shouldBypassMitmDns } = await import("../../open-sse/utils/proxyFetch.js");

    // Exact production host is bypassed.
    expect(shouldBypassMitmDns("https://api2.cursor.sh/v1/chat")).toBe(true);

    // Attacker-controlled subdomain of a bypass host must NOT be bypassed —
    // otherwise it would skip the SSRF DNS guard and reach the raw-IP path.
    expect(shouldBypassMitmDns("https://evil.api2.cursor.sh/v1/chat")).toBe(false);
    expect(shouldBypassMitmDns("https://api2.cursor.sh.attacker.com/")).toBe(false);

    // Unrelated host is untouched.
    expect(shouldBypassMitmDns("https://example.com/")).toBe(false);
  });
});

describe("CursorExecutor.makeHttp2ProxyRequest — CONNECT tunnel correctness", () => {
  let executor;
  let netConnectSpy;
  let tlsConnectSpy;

  const writes = [];

  function makeFakeProxySocket() {
    // Minimal duplex-ish stub: capture writes, drive the 'connect' callback,
    // expose .on for 'data'/'error', and let the test push a CONNECT response.
    const listeners = {};
    const sock = {
      write: (chunk) => { writes.push(String(chunk)); },
      on: (ev, cb) => { (listeners[ev] ||= []).push(cb); return sock; },
      removeListener: (ev, cb) => {
        listeners[ev] = (listeners[ev] || []).filter((f) => f !== cb);
        return sock;
      },
      destroy: vi.fn(),
      _emit: (ev, ...args) => (listeners[ev] || []).forEach((f) => f(...args)),
    };
    return sock;
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    writes.length = 0;
  });

  const tick = () => new Promise((r) => setImmediate(r));

  it("includes Proxy-Authorization when the proxy URL carries credentials", async () => {
    const { CursorExecutor } = await import("../../open-sse/executors/cursor.js");
    executor = new CursorExecutor();

    const sock = makeFakeProxySocket();
    // Real net.connect fires the connect callback asynchronously (on the
    // 'connect' event), after the caller has assigned the returned socket.
    netConnectSpy = vi.spyOn(net, "connect").mockImplementation((port, host, cb) => {
      if (typeof cb === "function") setImmediate(cb);
      return sock;
    });

    const p = executor.makeHttp2ProxyRequest(
      "https://api2.cursor.sh/v1/chat",
      { "content-type": "application/connect+proto" },
      Buffer.from("body"),
      null,
      { url: "http://user:p%40ss@proxy.example.com:8080" }
    );
    await tick();

    // The CONNECT request line must carry Basic auth (user:p@ss → base64).
    const connect = writes.join("");
    expect(connect).toContain("CONNECT api2.cursor.sh:443 HTTP/1.1");
    const expected = Buffer.from("user:p@ss").toString("base64");
    expect(connect).toContain(`Proxy-Authorization: Basic ${expected}`);

    // Drive a non-200 CONNECT reply so the promise rejects and the socket is torn down.
    sock._emit("data", Buffer.from("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n"));
    await expect(p).rejects.toThrow(/proxy returned 407/);
    expect(sock.destroy).toHaveBeenCalled();
  });

  it("uses tls.connect (not net.connect) for an https: proxy", async () => {
    const { CursorExecutor } = await import("../../open-sse/executors/cursor.js");
    const tlsMod = await import("tls");
    executor = new CursorExecutor();

    const sock = makeFakeProxySocket();
    netConnectSpy = vi.spyOn(net, "connect").mockReturnValue(makeFakeProxySocket());
    tlsConnectSpy = tlsMod.connect.mockImplementation((opts, cb) => {
      if (typeof cb === "function") setImmediate(cb);
      return sock;
    });

    const p = executor.makeHttp2ProxyRequest(
      "https://api2.cursor.sh/v1/chat",
      {},
      Buffer.from("body"),
      null,
      { url: "https://secure-proxy.example.com:443" }
    );
    await tick();

    // TLS handshake to the proxy itself must be initiated; plain net.connect must not.
    expect(tlsConnectSpy).toHaveBeenCalled();
    const firstArg = tlsConnectSpy.mock.calls[0][0];
    expect(firstArg).toMatchObject({ host: "secure-proxy.example.com", port: 443 });
    expect(netConnectSpy).not.toHaveBeenCalled();

    // Reject via malformed CONNECT response so the promise settles.
    sock._emit("data", Buffer.from("garbage-without-status\r\n\r\n"));
    await expect(p).rejects.toThrow(/malformed proxy response/);
  });

  it("rejects with NaN-safe message on a malformed status line", async () => {
    const { CursorExecutor } = await import("../../open-sse/executors/cursor.js");
    executor = new CursorExecutor();

    const sock = makeFakeProxySocket();
    vi.spyOn(net, "connect").mockImplementation((port, host, cb) => {
      if (typeof cb === "function") setImmediate(cb);
      return sock;
    });

    const p = executor.makeHttp2ProxyRequest(
      "https://api2.cursor.sh/v1/chat",
      {},
      Buffer.from("body"),
      null,
      { url: "http://proxy.example.com:8080" }
    );
    await tick();
    sock._emit("data", Buffer.from("HTTP/1.1 \r\n\r\n"));
    await expect(p).rejects.toThrow(/malformed proxy response/);
  });
});

describe("AbortError propagation in web executors", () => {
  const abortBody = { messages: [{ role: "user", content: "hi" }] };

  function abortErr() {
    const e = new Error("The operation was aborted");
    e.name = "AbortError";
    return e;
  }

  it("grok-web rethrows AbortError instead of returning a 502", async () => {
    vi.resetModules();
    vi.doMock("../../open-sse/utils/proxyFetch.js", () => ({
      proxyAwareFetch: vi.fn(async () => { throw abortErr(); }),
    }));
    const { GrokWebExecutor } = await import("../../open-sse/executors/grok-web.js");
    const ex = new GrokWebExecutor();
    await expect(ex.execute({
      model: "grok-4.1-fast", body: abortBody, stream: true,
      credentials: { apiKey: "sso=tok" }, signal: { aborted: true }, log: {},
    })).rejects.toThrow(/abort/i);
  });

  it("perplexity-web rethrows AbortError instead of returning a 502", async () => {
    vi.resetModules();
    vi.doMock("../../open-sse/utils/proxyFetch.js", () => ({
      proxyAwareFetch: vi.fn(async () => { throw abortErr(); }),
    }));
    const { PerplexityWebExecutor } = await import("../../open-sse/executors/perplexity-web.js");
    const ex = new PerplexityWebExecutor();
    await expect(ex.execute({
      model: "pplx-auto", body: abortBody, stream: true,
      credentials: { apiKey: "session-tok" }, signal: { aborted: true }, log: {},
    })).rejects.toThrow(/abort/i);
  });

  it("cursor rethrows AbortError instead of returning a 502", async () => {
    vi.resetModules();
    vi.doMock("../../open-sse/utils/proxyFetch.js", async (importOriginal) => {
      const actual = await importOriginal();
      return {
        ...actual,
        hasApplicableEnvProxy: vi.fn(() => false),
        resolveRealIP: vi.fn(async () => "1.2.3.4"),
        proxyAwareFetch: vi.fn(async () => { throw abortErr(); }),
      };
    });
    const { CursorExecutor } = await import("../../open-sse/executors/cursor.js");
    const ex = new CursorExecutor();
    await expect(ex.execute({
      model: "claude-3.5-sonnet",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: {
        accessToken: "test-token",
        providerSpecificData: { machineId: "test-machine-id", ghostMode: true },
      },
      signal: { aborted: true },
      log: {},
    })).rejects.toMatchObject({ name: "AbortError", message: "Request aborted" });
  });
});

describe("CursorExecutor.execute — relay vs connect-proxy routing", () => {
  const mockCredentials = {
    accessToken: "test-token",
    providerSpecificData: { machineId: "test-machine-id", ghostMode: true },
  };
  const mockBody = { messages: [{ role: "user", content: "hi" }] };

  async function freshExecutor() {
    vi.resetModules();
    vi.doMock("../../open-sse/utils/proxyFetch.js", async (importOriginal) => {
      const actual = await importOriginal();
      return {
        ...actual,
        hasApplicableEnvProxy: vi.fn(() => false),
        resolveRealIP: vi.fn(async () => "1.2.3.4"),
        proxyAwareFetch: vi.fn(),
      };
    });
    const { CursorExecutor } = await import("../../open-sse/executors/cursor.js");
    const ex = new CursorExecutor();
    const okBody = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x05, 0x0a, 0x03, 0x68, 0x69, 0x21]);
    vi.spyOn(ex, "makeHttp2Request").mockResolvedValue({ status: 200, headers: {}, body: okBody });
    vi.spyOn(ex, "makeFetchRequest").mockResolvedValue({ status: 200, headers: {}, body: okBody });
    vi.spyOn(ex, "makeHttp2ProxyRequest").mockResolvedValue({ status: 200, headers: {}, body: okBody });
    return ex;
  }

  it("relay-only config uses the fetch path, NOT the CONNECT tunnel", async () => {
    const ex = await freshExecutor();
    await ex.execute({
      model: "claude-3.5-sonnet", body: mockBody, stream: true,
      credentials: mockCredentials, signal: null, log: () => {},
      proxyOptions: { vercelRelayUrl: "https://relay.example.com/proxy" },
    });
    expect(ex.makeHttp2ProxyRequest).not.toHaveBeenCalled();
    expect(ex.makeFetchRequest).toHaveBeenCalled();
  });

  it("connect-proxy + Cursor uses the HTTP/2-over-CONNECT tunnel", async () => {
    const ex = await freshExecutor();
    await ex.execute({
      model: "claude-3.5-sonnet", body: mockBody, stream: true,
      credentials: mockCredentials, signal: null, log: () => {},
      proxyOptions: { enabled: true, url: "http://proxy.example.com:8080" },
    });
    expect(ex.makeHttp2ProxyRequest).toHaveBeenCalled();
    expect(ex.makeFetchRequest).not.toHaveBeenCalled();
  });
});
