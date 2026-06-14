import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CursorExecutor } from "../../open-sse/executors/cursor.js";

describe("proxy routing mismatch regressions", () => {
  const envBackup = { ...process.env };
  const fetchBackup = globalThis.fetch;

  beforeEach(() => {
    process.env = { ...envBackup };
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.ALL_PROXY;
    delete process.env.NO_PROXY;
    delete process.env.http_proxy;
    delete process.env.https_proxy;
    delete process.env.all_proxy;
    delete process.env.no_proxy;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = envBackup;
    globalThis.fetch = fetchBackup;
    vi.doUnmock("../../open-sse/utils/ssrfGuard.js");
    vi.restoreAllMocks();
  });

  it("CursorExecutor uses proxy-aware fetch instead of direct HTTP/2 when an env proxy applies", async () => {
    process.env.HTTPS_PROXY = "http://env-proxy.example.com:8080";
    const executor = new CursorExecutor();
    const upstream = { status: 200, headers: {}, body: Buffer.from("ok") };
    const http2Spy = vi.spyOn(executor, "makeHttp2Request").mockResolvedValue(upstream);
    const fetchSpy = vi.spyOn(executor, "makeFetchRequest").mockResolvedValue(upstream);

    const result = await executor.execute({
      model: "cursor-small",
      body: Buffer.from("provider-native"),
      stream: true,
      credentials: {
        accessToken: "tok",
        providerSpecificData: { machineId: "mid-123" },
      },
      passthrough: true,
    });

    expect(result.response.status).toBe(200);
    expect(http2Spy).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("relay proxy routing honors connectionNoProxy before using the relay", async () => {
    const originalFetch = vi.fn(async () => new Response("ok", { status: 200 }));
    globalThis.fetch = originalFetch;
    vi.resetModules();
    vi.doMock("../../open-sse/utils/ssrfGuard.js", () => ({
      assertSafeResolvedHostname: vi.fn(async () => true),
    }));

    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js?relay-no-proxy");
    await proxyAwareFetch("https://api.example.com/v1/chat", {}, {
      vercelRelayUrl: "https://relay.example.net/api/relay",
      connectionNoProxy: "example.com",
    });

    expect(originalFetch).toHaveBeenCalledOnce();
    expect(originalFetch.mock.calls[0][0]).toBe("https://api.example.com/v1/chat");
  });

  it("relay proxy routing still uses the relay when no no-proxy rule matches", async () => {
    const originalFetch = vi.fn(async () => new Response("ok", { status: 200 }));
    globalThis.fetch = originalFetch;
    vi.resetModules();
    vi.doMock("../../open-sse/utils/ssrfGuard.js", () => ({
      assertSafeResolvedHostname: vi.fn(async () => true),
    }));

    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js?relay-match");
    await proxyAwareFetch("https://api.example.com/v1/chat", {}, {
      vercelRelayUrl: "https://relay.example.net/api/relay",
      connectionNoProxy: "internal.example.net",
    });

    expect(originalFetch).toHaveBeenCalledOnce();
    expect(originalFetch.mock.calls[0][0]).toBe("https://relay.example.net/api/relay");
    expect(originalFetch.mock.calls[0][1].headers["x-relay-target"]).toBe("https://api.example.com");
    expect(originalFetch.mock.calls[0][1].headers["x-relay-path"]).toBe("/v1/chat");
  });

  it("connectionNoProxy bypasses environment proxy when host matches", async () => {
    process.env.HTTPS_PROXY = "http://env-proxy.example.com:8080";
    const originalFetch = vi.fn(async () => new Response("ok", { status: 200 }));
    globalThis.fetch = originalFetch;
    vi.resetModules();
    vi.doMock("../../open-sse/utils/ssrfGuard.js", () => ({
      assertSafeResolvedHostname: vi.fn(async () => true),
    }));

    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js?no-proxy-over-env");
    await proxyAwareFetch("https://api.example.com/v1/chat", {}, {
      vercelRelayUrl: "https://relay.example.net/api/relay",
      connectionNoProxy: "example.com",
    });

    expect(originalFetch).toHaveBeenCalledOnce();
    expect(originalFetch.mock.calls[0][0]).toBe("https://api.example.com/v1/chat");
    expect(originalFetch.mock.calls[0][1].dispatcher).toBeDefined();
    expect(originalFetch.mock.calls[0][1].headers?.["x-relay-target"]).toBeUndefined();
  });

  it("environment proxy takes precedence over relay proxy routing", async () => {
    process.env.HTTPS_PROXY = "http://env-proxy.example.com:8080";
    const originalFetch = vi.fn(async () => new Response("ok", { status: 200 }));
    globalThis.fetch = originalFetch;
    vi.resetModules();
    vi.doMock("../../open-sse/utils/ssrfGuard.js", () => ({
      assertSafeResolvedHostname: vi.fn(async () => true),
    }));

    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js?env-before-relay");
    await proxyAwareFetch("https://api.example.com/v1/chat", {}, {
      vercelRelayUrl: "https://relay.example.net/api/relay",
    });

    expect(originalFetch).toHaveBeenCalledOnce();
    expect(originalFetch.mock.calls[0][0]).toBe("https://api.example.com/v1/chat");
    expect(originalFetch.mock.calls[0][1].dispatcher).toBeDefined();
    expect(originalFetch.mock.calls[0][1].headers?.["x-relay-target"]).toBeUndefined();
  });
});
