import { describe, it, expect, vi } from "vitest";

vi.mock("undici", () => ({
  ProxyAgent: vi.fn(),
  fetch: vi.fn(),
}));

const { testProxyUrl } = await import("../../src/lib/network/proxyTest.js");

describe("testProxyUrl — proxy endpoint SSRF guard", () => {
  it("rejects a loopback proxy URL before opening a connection", async () => {
    const result = await testProxyUrl({
      proxyUrl: "http://127.0.0.1:8080",
      testUrl: "https://example.com/",
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/not allowed/i);
  });

  it("rejects unsupported proxy schemes", async () => {
    const result = await testProxyUrl({
      proxyUrl: "socks5://proxy.example.com:1080",
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/Unsupported proxy scheme/i);
  });
});
