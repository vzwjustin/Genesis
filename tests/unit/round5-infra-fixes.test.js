/**
 * Round 5 — usage/MITM/infra fixes: antigravity project id, GitHub MITM bypass,
 * DNS resolver settings, pending timeout decrement, GLM quota keys, migrate priority 0.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");

const mockGetSettings = vi.fn();

vi.mock("../../src/lib/db/repos/settingsRepo.js", () => ({
  getSettings: (...args) => mockGetSettings(...args),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    proxyAwareFetch: vi.fn(),
  };
});

const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
const { getUsageForProvider } = await import("../../open-sse/services/usage.js");
const {
  MITM_BYPASS_HOSTS,
  shouldBypassMitmDns,
  extractDnsServersFromSettings,
  getMitmDnsServers,
} = await import("../../open-sse/utils/proxyFetch.js");

describe("Round 5 — MITM bypass hosts", () => {
  it("includes api.github.com for Copilot usage", () => {
    expect(MITM_BYPASS_HOSTS).toContain("api.github.com");
    expect(shouldBypassMitmDns("https://api.github.com/copilot_internal/user")).toBe(true);
  });
});

describe("Round 5 — DNS resolver settings", () => {
  beforeEach(() => {
    mockGetSettings.mockReset();
  });

  it("extractDnsServersFromSettings keeps enabled IP resolvers only", () => {
    expect(
      extractDnsServersFromSettings({
        "1.1.1.1": true,
        "8.8.8.8": true,
        cursor: true,
        "9.9.9.9": false,
      })
    ).toEqual(["1.1.1.1", "8.8.8.8"]);
  });

  it("getMitmDnsServers falls back to 8.8.8.8 when no IP resolvers configured", async () => {
    mockGetSettings.mockResolvedValue({ dnsToolEnabled: { cursor: true } });
    await expect(getMitmDnsServers()).resolves.toEqual(["8.8.8.8"]);
  });

  it("getMitmDnsServers loads enabled resolver IPs from settingsRepo", async () => {
    mockGetSettings.mockResolvedValue({ dnsToolEnabled: { "1.1.1.1": true, "8.8.8.8": true } });
    await expect(getMitmDnsServers()).resolves.toEqual(["1.1.1.1", "8.8.8.8"]);
  });
});

describe("Round 5 — usageRepo pending timeout decrement", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    global._pendingRequests = { byModel: {}, byAccount: {} };
    global._pendingTimers = {};
    global._nextPendingRequestId = 1;
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.values(global._pendingTimers || {}).forEach(clearTimeout);
    global._pendingTimers = {};
  });

  it("decrements one pending slot per timed-out request handle", async () => {
    const { trackPendingRequest } = await import("../../src/lib/db/repos/usageRepo.js");

    const h1 = trackPendingRequest("gpt-4", "openai", "c1", true);
    trackPendingRequest("gpt-4", "openai", "c1", true);
    expect(global._pendingRequests.byModel["gpt-4 (openai)"]).toBe(2);
    expect(global._pendingRequests.byAccount.c1["gpt-4 (openai)"]).toBe(2);

    trackPendingRequest("gpt-4", "openai", "c1", false, false, h1);
    expect(global._pendingRequests.byModel["gpt-4 (openai)"]).toBe(1);
    expect(global._pendingRequests.byAccount.c1["gpt-4 (openai)"]).toBe(1);

    vi.advanceTimersByTime(60_000);

    expect(global._pendingRequests.byModel["gpt-4 (openai)"]).toBeUndefined();
    expect(global._pendingRequests.byAccount.c1?.["gpt-4 (openai)"]).toBeUndefined();
  });
});

describe("Round 5 — GLM quota keys", () => {
  beforeEach(() => {
    vi.mocked(proxyAwareFetch).mockReset();
  });

  it("keys session and weekly token limits separately instead of overwriting session", async () => {
    vi.mocked(proxyAwareFetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            level: "pro",
            limits: [
              {
                type: "TOKENS_LIMIT",
                unit: 3,
                number: 5,
                percentage: 20,
                nextResetTime: 1770648402389,
              },
              {
                type: "TOKENS_LIMIT",
                unit: 6,
                number: 7,
                percentage: 55,
                nextResetTime: 1771253202389,
              },
              {
                type: "TIME_LIMIT",
                unit: 5,
                number: 1,
                percentage: 10,
              },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await getUsageForProvider({
      provider: "glm",
      apiKey: "test-key",
    });

    expect(result.quotas["session (5h)"]).toMatchObject({ used: 20, total: 100 });
    expect(result.quotas["weekly (7d)"]).toMatchObject({ used: 55, total: 100 });
    expect(result.quotas["web searches"]).toMatchObject({ used: 10, total: 100 });
    expect(Object.keys(result.quotas)).toHaveLength(3);
  });
});

describe("Round 5 — Antigravity project normalization", () => {
  beforeEach(() => {
    vi.mocked(proxyAwareFetch).mockReset();
  });

  it("normalizes object cloudaicompanionProject before quota fetch", async () => {
    vi.mocked(proxyAwareFetch).mockImplementation(async (url, options) => {
      if (String(url).includes("loadCodeAssist")) {
        return new Response(
          JSON.stringify({
            cloudaicompanionProject: { id: "  my-gcp-project  " },
            currentTier: { name: "Standard" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (String(url).includes("fetchAvailableModels")) {
        return new Response(JSON.stringify({ models: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });

    await getUsageForProvider({
      provider: "antigravity",
      accessToken: "token",
    });

    const quotaCall = vi.mocked(proxyAwareFetch).mock.calls.find(([url]) =>
      String(url).includes("fetchAvailableModels")
    );
    expect(quotaCall).toBeDefined();
    const body = JSON.parse(quotaCall[1].body);
    expect(body.project).toBe("my-gcp-project");
  });

  it("prefers connection projectId over subscription lookup", async () => {
    vi.mocked(proxyAwareFetch).mockImplementation(async (url, options) => {
      if (String(url).includes("loadCodeAssist")) {
        return new Response(
          JSON.stringify({ cloudaicompanionProject: "subscription-project" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (String(url).includes("fetchAvailableModels")) {
        return new Response(JSON.stringify({ models: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });

    await getUsageForProvider({
      provider: "antigravity",
      accessToken: "token",
      projectId: "connection-project",
    });

    const quotaCall = vi.mocked(proxyAwareFetch).mock.calls.find(([url]) =>
      String(url).includes("fetchAvailableModels")
    );
    const body = JSON.parse(quotaCall[1].body);
    expect(body.project).toBe("connection-project");
  });
});

describe("Round 5 — migrate.js priority 0", () => {
  it("uses nullish coalescing so priority 0 is preserved on legacy import", () => {
    const src = readFileSync(join(root, "src/lib/db/migrate.js"), "utf8");
    expect(src).toContain("priority ?? null");
    expect(src).not.toMatch(/priority \|\| null/);
  });
});
