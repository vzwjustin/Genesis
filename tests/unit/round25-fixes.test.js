/**
 * Round 25 — bug-hunt fixes: Claude tool responses, model resolution,
 * rateLimitedUntil Retry-After, SSRF CGNAT, loopback spoofing, bypass stream settle.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fixMissingToolResponses } from "../../open-sse/translator/helpers/toolCallHelper.js";
import { getModelInfoCore } from "../../open-sse/services/model.js";
import {
  cleanAnthropicToolDefinitions,
  stripProviderModelPrefix,
} from "../../open-sse/translator/helpers/claudeHelper.js";
import {
  isLoopbackRequest,
  isVerifiableLoopbackRequest,
  isDashboardLoopbackSession,
  isCliLoopbackClient,
} from "../../src/shared/utils/loopbackRequest.js";
import {
  isBlockedHostname,
  assertSafeResolvedHostname,
} from "../../open-sse/utils/ssrfGuard.js";

const mockGetSettings = vi.fn().mockResolvedValue({ fallbackStrategy: "fill-first", providerStrategies: {} });

vi.mock("@/lib/localDb", () => ({
  getSettings: mockGetSettings,
  getSettingsSafe: mockGetSettings,
  getProviderConnections: vi.fn(),
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn().mockResolvedValue({
    connectionProxyEnabled: false,
    connectionProxyUrl: null,
    connectionNoProxy: null,
    proxyPoolId: null,
    vercelRelayUrl: "",
  }),
}));

vi.mock("@/shared/constants/providers.js", () => ({
  resolveProviderId: (p) => p,
  FREE_PROVIDERS: {},
}));

vi.mock("open-sse/config/errorConfig.js", () => ({
  MAX_RATE_LIMIT_COOLDOWN_MS: 300000,
}));

vi.mock("../../src/sse/utils/logger.js", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  request: vi.fn(),
}));

const { getProviderConnections } = await import("@/lib/localDb");
const { getProviderCredentials } = await import("../../src/sse/services/auth.js");

function makeRequest(headers = {}, socketIp = null) {
  return {
    headers: {
      get: (name) => headers[name] ?? headers[name.toLowerCase()] ?? null,
    },
    socket: socketIp ? { remoteAddress: socketIp } : undefined,
    ip: socketIp || undefined,
  };
}

describe("Round 25 — Claude-native fixMissingToolResponses", () => {
  it("inserts user tool_result blocks instead of OpenAI role=tool messages", () => {
    const body = {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_01", name: "bash", input: {} },
          ],
        },
        { role: "user", content: "continue" },
      ],
    };

    fixMissingToolResponses(body);

    expect(body.messages[1].role).toBe("user");
    expect(body.messages[1].content).toEqual([
      { type: "tool_result", tool_use_id: "toolu_01", content: "[No response received]" },
    ]);
    expect(body.messages.some((m) => m.role === "tool")).toBe(false);
  });
});

describe("Round 25 — getModelInfoCore fail-closed", () => {
  it("returns null provider for unresolved alias (no inference)", async () => {
    const result = await getModelInfoCore("some-unknown-model", {});
    expect(result.provider).toBeNull();
    expect(result.model).toBe("some-unknown-model");
  });

  it("returns null provider for claude-like name not in alias registry", async () => {
    const result = await getModelInfoCore("claude-sonnet-4-20250514", {});
    expect(result.provider).toBeNull();
  });
});

describe("Round 25 — nested built-in tool model prefix strip", () => {
  it("strips multiple provider prefixes from built-in tool model", () => {
    expect(stripProviderModelPrefix("provider/cc/claude-opus-4-6")).toBe("claude-opus-4-6");
    const tools = [{ type: "web_search_20250305", name: "web_search", model: "provider/cc/claude-opus-4-6" }];
    const cleaned = cleanAnthropicToolDefinitions(tools, "claude");
    expect(cleaned[0].model).toBe("claude-opus-4-6");
  });
});

describe("Round 25 — loopback Host spoofing blocked", () => {
  it("allows loopback Host without Origin when socket IP is unavailable (CLI direct connect)", () => {
    expect(isLoopbackRequest(makeRequest({ host: "localhost:20128" }))).toBe(true);
  });

  it("allows loopback Host with loopback Origin when socket IP is unavailable", () => {
    expect(isLoopbackRequest(makeRequest({
      host: "localhost:20128",
      origin: "http://localhost:20128",
    }))).toBe(true);
  });

  it("rejects loopback Host without Origin when proxy headers indicate remote client", () => {
    expect(isLoopbackRequest(makeRequest({
      host: "localhost:20128",
      "x-forwarded-for": "203.0.113.9",
    }))).toBe(false);
  });

  it("rejects loopback Host when XFF spoofs loopback IP without loopback socket", () => {
    expect(isLoopbackRequest(makeRequest({
      host: "localhost:20128",
      "x-forwarded-for": "127.0.0.1",
      origin: "http://localhost:20128",
    }))).toBe(false);
  });

  it("rejects loopback Host when cf-connecting-ip is remote", () => {
    expect(isLoopbackRequest(makeRequest({
      host: "localhost:20128",
      "cf-connecting-ip": "203.0.113.9",
    }))).toBe(false);
  });

  it("rejects loopback Host when Forwarded claims loopback but socket IP is remote", () => {
    expect(isLoopbackRequest(makeRequest({
      host: "localhost:20128",
      forwarded: "for=127.0.0.1;proto=https",
    }, "203.0.113.9"))).toBe(false);
  });

  it("rejects loopback Host when RFC 7239 Forwarded indicates remote client", () => {
    expect(isLoopbackRequest(makeRequest({
      host: "localhost:20128",
      forwarded: "for=203.0.113.9;proto=https",
    }))).toBe(false);
  });

  it("allows loopback Host when XFF is loopback and socket IP is loopback (local proxy)", () => {
    expect(isLoopbackRequest(makeRequest({
      host: "localhost:20128",
      "x-forwarded-for": "127.0.0.1",
    }, "127.0.0.1"))).toBe(true);
  });

  it("allows loopback Host when socket IP is loopback", () => {
    expect(isLoopbackRequest(makeRequest({ host: "localhost:20128" }, "127.0.0.1"))).toBe(true);
  });

  it("rejects loopback Host when socket IP is remote", () => {
    expect(isLoopbackRequest(makeRequest({ host: "localhost:20128" }, "203.0.113.9"))).toBe(false);
  });
});

describe("Round 25 — verifiable loopback for management API", () => {
  it("rejects loopback Host without socket IP (Host header alone is not enough)", () => {
    expect(isVerifiableLoopbackRequest(makeRequest({ host: "localhost:20128" }))).toBe(false);
  });

  it("allows loopback Host with loopback socket IP", () => {
    expect(isVerifiableLoopbackRequest(makeRequest({ host: "localhost:20128" }, "127.0.0.1"))).toBe(true);
  });

  it("still allows CLI-style loopback for public LLM auth when socket is unavailable", () => {
    expect(isLoopbackRequest(makeRequest({ host: "localhost:20128" }))).toBe(true);
    expect(isVerifiableLoopbackRequest(makeRequest({ host: "localhost:20128" }))).toBe(false);
  });
});

describe("dashboard loopback session detection", () => {
  it("allows dashboard fetch with loopback Origin and no socket", () => {
    expect(isDashboardLoopbackSession(makeRequest({
      host: "localhost:20128",
      origin: "http://localhost:20128",
    }))).toBe(true);
  });

  it("rejects dashboard fetch with remote Origin", () => {
    expect(isDashboardLoopbackSession(makeRequest({
      host: "localhost:20128",
      origin: "http://evil.example.com",
    }))).toBe(false);
  });

  it("treats CLI HTTP client as loopback when Origin is absent", () => {
    expect(isCliLoopbackClient(makeRequest({
      host: "localhost:20128",
      "x-9r-cli-token": "abc",
    }))).toBe(true);
    expect(isCliLoopbackClient(makeRequest({
      host: "localhost:20128",
      origin: "http://localhost:20128",
    }))).toBe(false);
  });
});

describe("Round 25 — link-local IPv6 is not loopback", () => {
  it("rejects fe80 link-local socket IPs for loopback-only access", () => {
    expect(isLoopbackRequest(makeRequest({ host: "localhost:20128" }, "fe80::1"))).toBe(false);
  });
});

describe("Round 25 — SSRF blocks CGNAT range", () => {
  it("blocks 100.64.0.0/10 hostnames", () => {
    expect(isBlockedHostname("100.64.0.1")).toBe(true);
    expect(isBlockedHostname("100.127.255.254")).toBe(true);
  });

  it("assertSafeResolvedHostname blocks 100.64.x.x", async () => {
    await expect(assertSafeResolvedHostname("100.64.1.1")).rejects.toThrow(/not allowed/);
  });
});

describe("Round 25 — rateLimitedUntil-only returns allRateLimited", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns allRateLimited with retryAfter when only legacy rateLimitedUntil excludes accounts", async () => {
    const futureTime = new Date(Date.now() + 120000).toISOString();
    getProviderConnections.mockResolvedValue([
      {
        id: "conn-rl",
        priority: 1,
        rateLimitedUntil: futureTime,
        testStatus: "active",
      },
    ]);

    const result = await getProviderCredentials("claude");
    expect(result.allRateLimited).toBe(true);
    expect(result.retryAfter).toBe(futureTime);
    expect(result.retryAfterHuman).toMatch(/reset after/);
  });
});
