import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeProxyUrl, resolveConnectionProxyUrl } from "../../open-sse/utils/proxyFetch.js";

const root = dirname(fileURLToPath(import.meta.url));

describe("proxy URL validation", () => {
  it("normalizes bare host:port proxy URLs as http URLs", () => {
    expect(normalizeProxyUrl("localhost:8080")).toBe("http://localhost:8080");
    expect(normalizeProxyUrl("proxy.example.com:3128")).toBe("http://proxy.example.com:3128");
    expect(normalizeProxyUrl("127.0.0.1:7890")).toBe("http://127.0.0.1:7890");
  });

  it("rejects unsupported proxy URL schemes", () => {
    expect(() => normalizeProxyUrl("file:///tmp/proxy.sock")).toThrow(/http or https/);
    expect(() => normalizeProxyUrl("ssh://proxy.example.com")).toThrow(/http or https/);
  });

  it("can ignore invalid runtime proxy URLs without throwing", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(normalizeProxyUrl("socks5://proxy.example.com:1080", false)).toBeNull();
    expect(resolveConnectionProxyUrl("https://api.example.com/v1/chat", {
      connectionProxyEnabled: true,
      connectionProxyUrl: "socks5://proxy.example.com:1080",
      strictProxy: false,
    })).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith("[ProxyFetch] Ignoring invalid connection proxy URL");
    expect(() => resolveConnectionProxyUrl("https://api.example.com/v1/chat", {
      connectionProxyEnabled: true,
      connectionProxyUrl: "socks5://proxy.example.com:1080",
      strictProxy: true,
    })).toThrow(/Strict connection proxy URL is invalid/);
    warnSpy.mockRestore();
  });

  it("normalizes proxy URLs before provider and proxy-pool config is saved", () => {
    const files = [
      "../../src/app/api/providers/route.js",
      "../../src/app/api/providers/[id]/route.js",
      "../../src/app/api/proxy-pools/route.js",
      "../../src/app/api/proxy-pools/[id]/route.js",
    ];

    for (const file of files) {
      const src = readFileSync(join(root, file), "utf8");
      expect(src).toContain("normalizeProxyUrl");
    }
  });

  it("does not expose raw deployment errors from token-bearing relay deploy routes", () => {
    const files = [
      "../../src/app/api/proxy-pools/vercel-deploy/route.js",
      "../../src/app/api/proxy-pools/cloudflare-deploy/route.js",
      "../../src/app/api/proxy-pools/deno-deploy/route.js",
    ];

    for (const file of files) {
      const src = readFileSync(join(root, file), "utf8");
      expect(src).not.toMatch(/console\.(log|error)\([^)]*,\s*error\)/);
      expect(src).not.toMatch(/error:\s*error\.message\s*\|\|\s*"Deploy failed"/);
      expect(src).toContain("error?.stack || error");
    }
  });

  it("does not dump raw error objects from provider or proxy-pool API routes", () => {
    const files = [
      "../../src/app/api/providers/route.js",
      "../../src/app/api/providers/[id]/route.js",
      "../../src/app/api/providers/[id]/models/route.js",
      "../../src/app/api/providers/[id]/test-models/route.js",
      "../../src/app/api/providers/[id]/test/route.js",
      "../../src/app/api/providers/client/route.js",
      "../../src/app/api/providers/test-batch/route.js",
      "../../src/app/api/providers/validate/route.js",
      "../../src/app/api/proxy-pools/route.js",
      "../../src/app/api/proxy-pools/[id]/route.js",
      "../../src/app/api/proxy-pools/[id]/test/route.js",
    ];

    for (const file of files) {
      const src = readFileSync(join(root, file), "utf8");
      expect(src).not.toMatch(/console\.(log|error)\([^)]*,\s*error\)/);
    }
  });
});
