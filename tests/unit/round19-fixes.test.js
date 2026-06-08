/**
 * Round 19 — internal API helper, combo account exhaustion, MCP registry hardening
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  handleComboChat,
  isProviderAccountsExhaustedResponse,
  isModelResolutionFailureResponse,
} from "../../open-sse/services/combo.js";

const proxyAwareFetch = vi.hoisted(() => vi.fn());
const mockFetch = vi.hoisted(() => vi.fn());

vi.mock("open-sse/utils/proxyFetch.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    proxyAwareFetch: (...args) => proxyAwareFetch(...args),
  };
});

const mockLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const root = dirname(fileURLToPath(import.meta.url));

describe("isProviderAccountsExhaustedResponse", () => {
  it("returns true for 401/403 with Retry-After header", async () => {
    const withRetry = (status) =>
      new Response(JSON.stringify({ error: { message: "unauthorized" } }), {
        status,
        headers: { "Retry-After": "30", "Content-Type": "application/json" },
      });
    expect(await isProviderAccountsExhaustedResponse(withRetry(401))).toBe(true);
    expect(await isProviderAccountsExhaustedResponse(withRetry(403))).toBe(true);
  });

  it("returns true for known proxy exhaustion messages", async () => {
    const messages = [
      "All accounts unavailable for provider openai",
      "No more accounts available",
      "Token refresh failed for connection abc",
      "No active credentials for provider: claude",
    ];
    for (const message of messages) {
      const response = new Response(JSON.stringify({ error: { message } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
      expect(await isProviderAccountsExhaustedResponse(response)).toBe(true);
    }
  });

  it("returns false for bare upstream 401/403 without proxy signals", async () => {
    for (const status of [401, 403]) {
      const response = new Response(JSON.stringify({ error: { message: "unauthorized" } }), {
        status,
        headers: { "Content-Type": "application/json" },
      });
      expect(await isProviderAccountsExhaustedResponse(response)).toBe(false);
    }
  });

  it("returns false for non-auth status codes", async () => {
    const response = new Response(JSON.stringify({ error: { message: "All accounts unavailable" } }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
    expect(await isProviderAccountsExhaustedResponse(response)).toBe(false);
  });
});

describe("isModelResolutionFailureResponse — broken combo message", () => {
  it("returns true for combo with no valid model targets", async () => {
    const response = new Response(
      JSON.stringify({ error: { message: 'Combo "empty" has no valid model targets configured.' } }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
    expect(await isModelResolutionFailureResponse(response)).toBe(true);
  });
});

describe("handleComboChat — provider account exhaustion advances", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("advances past 401 with Retry-After to next model", async () => {
    const callOrder = [];
    const handleSingleModel = vi.fn(async (_body, model) => {
      callOrder.push(model);
      if (model === "openai/gpt-4o") {
        return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 401,
          headers: { "Retry-After": "60", "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    });

    const result = await handleComboChat({
      body: { messages: [] },
      models: ["openai/gpt-4o", "anthropic/claude-sonnet"],
      handleSingleModel,
      log: mockLog,
    });

    expect(callOrder).toEqual(["openai/gpt-4o", "anthropic/claude-sonnet"]);
    expect(result.status).toBe(200);
  });

  it("advances past 401 with All accounts unavailable message", async () => {
    const callOrder = [];
    const handleSingleModel = vi.fn(async (_body, model) => {
      callOrder.push(model);
      if (model === "openai/gpt-4o") {
        return new Response(JSON.stringify({ error: { message: "All accounts unavailable" } }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    });

    const result = await handleComboChat({
      body: { messages: [] },
      models: ["openai/gpt-4o", "anthropic/claude-sonnet"],
      handleSingleModel,
      log: mockLog,
    });

    expect(callOrder).toEqual(["openai/gpt-4o", "anthropic/claude-sonnet"]);
    expect(result.status).toBe(200);
  });

  it("does NOT advance on bare 401 without proxy exhaustion signals", async () => {
    const callOrder = [];
    const handleSingleModel = vi.fn(async (_body, model) => {
      callOrder.push(model);
      return new Response(JSON.stringify({ error: { message: "unauthorized" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    });

    const result = await handleComboChat({
      body: { messages: [] },
      models: ["openai/gpt-4o", "anthropic/claude-sonnet"],
      handleSingleModel,
      log: mockLog,
    });

    expect(callOrder).toEqual(["openai/gpt-4o"]);
    expect(result.status).toBe(401);
  });
});

describe("internalApi shared helper", () => {
  const apiRoot = join(root, "../../src");

  it("models/test and test-models routes use internalApi helpers", () => {
    const modelsTest = readFileSync(join(apiRoot, "app/api/models/test/route.js"), "utf8");
    expect(modelsTest).toContain("internalApiPost");
    expect(modelsTest).not.toMatch(/\bfetch\s*\(/);

    const testModels = readFileSync(join(apiRoot, "app/api/providers/[id]/test-models/route.js"), "utf8");
    expect(testModels).toContain("internalApiGet");
    expect(testModels).toContain("internalApiPost");
    expect(testModels).not.toMatch(/\bfetch\s*\(/);
  });

  it("internalApi uses loopback origin and CLI token header", () => {
    const src = readFileSync(join(apiRoot, "lib/internalApi.js"), "utf8");
    expect(src).toContain("127.0.0.1");
    expect(src).toContain("x-9r-cli-token");
    expect(src).toContain("parseError");
  });

  beforeEach(() => {
    vi.resetModules();
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
    vi.doMock("@/lib/localDb", () => ({
      getApiKeys: vi.fn().mockResolvedValue([{ key: "sk-test", isActive: true }]),
    }));
    vi.doMock("@/shared/utils/machineId", () => ({
      getConsistentMachineId: vi.fn().mockResolvedValue("machine-token"),
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock("@/lib/localDb");
    vi.doUnmock("@/shared/utils/machineId");
  });

  it("internalApiPost fails closed on invalid JSON for HTTP 200", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "not-json",
    });

    const { internalApiPost } = await import("../../src/lib/internalApi.js");
    const { res, parseError } = await internalApiPost("/api/v1/chat/completions", { model: "x" });

    expect(res.ok).toBe(true);
    expect(parseError).toBe("Invalid JSON response");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("127.0.0.1"),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer sk-test",
          "x-9r-cli-token": "machine-token",
        }),
      })
    );
  });
});

describe("cowork MCP registry pagination hardening", () => {
  const CACHE_KEY = "__9routerCoworkMcpRegistryCache";

  beforeEach(() => {
    vi.resetModules();
    proxyAwareFetch.mockReset();
    delete globalThis[CACHE_KEY];
  });

  afterEach(() => {
    delete globalThis[CACHE_KEY];
  });

  it("route source includes cursor loop guard, partial results, and stale cache fallback", () => {
    const src = readFileSync(
      join(root, "../../src/app/api/cli-tools/cowork-mcp-registry/route.js"),
      "utf8"
    );
    expect(src).toContain("seenCursors");
    expect(src).toContain("partial");
    expect(src).toContain("stale: true");
    expect(src).toContain("proxyAwareFetch");
  });

  it("returns stale cache when refresh fails but prior data exists", async () => {
    globalThis[CACHE_KEY] = {
      ts: 0,
      data: { servers: [{ name: "cached", url: "https://example.com/mcp" }], total: 1 },
    };

    proxyAwareFetch.mockResolvedValue({
      ok: false,
      status: 502,
    });

    const { GET } = await import("../../src/app/api/cli-tools/cowork-mcp-registry/route.js");
    const response = await GET(new Request("http://localhost/api/cli-tools/cowork-mcp-registry?refresh=1"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.stale).toBe(true);
    expect(body.cached).toBe(true);
    expect(body.servers).toHaveLength(1);
    expect(body.warning).toContain("502");
  });

  it("stops pagination when nextCursor repeats current cursor", async () => {
    const page = {
      servers: [
        {
          server: {
            name: "demo",
            title: "Demo",
            remotes: [{ url: "https://example.com/mcp", type: "http" }],
          },
          _meta: { "com.anthropic.api/mcp-registry": { slug: "demo", isAuthless: true } },
        },
      ],
      metadata: { nextCursor: "same-cursor" },
    };

    proxyAwareFetch.mockResolvedValue({
      ok: true,
      json: async () => page,
    });

    const { GET } = await import("../../src/app/api/cli-tools/cowork-mcp-registry/route.js");
    const response = await GET(new Request("http://localhost/api/cli-tools/cowork-mcp-registry?refresh=1"));
    const body = await response.json();

    // First page + one follow-up, then breaks because nextCursor === cursor
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
    expect(body.servers).toHaveLength(1);
    expect(proxyAwareFetch.mock.calls.length).toBeLessThan(20);
  });
});
