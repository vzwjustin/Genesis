/**
 * Round-5 API route fixes: models/info, availability, usage, request-logs,
 * oauth poll-status, v1beta parser, kiro social-exchange, count_tokens,
 * v1beta models list, usage stream, importDb validation.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";

const root = path.join(import.meta.dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

// ── mocks shared across suites ──────────────────────────────────────────────

const routeAuthMock = vi.fn(async () => ({ ok: true }));
vi.mock("@/sse/utils/routeAuth.js", () => ({
  requireRouteAuth: (...args) => routeAuthMock(...args),
}));

const localDbMocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
  getProviderConnectionById: vi.fn(),
}));

vi.mock("@/lib/localDb", () => localDbMocks);

const usageMocks = vi.hoisted(() => ({
  getUsageForProvider: vi.fn(),
}));

vi.mock("open-sse/services/usage.js", () => ({
  getUsageForProvider: (...args) => usageMocks.getUsageForProvider(...args),
}));

vi.mock("open-sse/executors/index.js", () => ({
  getExecutor: () => ({ supportsTokenRefresh: false, needsRefresh: () => false }),
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({})),
}));

vi.mock("open-sse/index.js", () => ({}));

const oauthServerMocks = vi.hoisted(() => ({
  getCodexSessionStatus: vi.fn(),
  consumeCodexSession: vi.fn(),
  clearCodexSession: vi.fn(),
  getXaiSessionStatus: vi.fn(),
  consumeXaiSession: vi.fn(),
  clearXaiSession: vi.fn(),
}));

vi.mock("@/lib/oauth/utils/server", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getCodexSessionStatus: oauthServerMocks.getCodexSessionStatus,
    consumeCodexSession: oauthServerMocks.consumeCodexSession,
    clearCodexSession: oauthServerMocks.clearCodexSession,
    getXaiSessionStatus: oauthServerMocks.getXaiSessionStatus,
    consumeXaiSession: oauthServerMocks.consumeXaiSession,
    clearXaiSession: oauthServerMocks.clearXaiSession,
  };
});

vi.mock("@/lib/oauth/providers", () => ({
  getProvider: vi.fn(),
  generateAuthData: vi.fn(),
  exchangeTokens: vi.fn(),
  requestDeviceCode: vi.fn(),
  pollForToken: vi.fn(),
}));

vi.mock("@/models", () => ({ createProviderConnection: vi.fn() }));
vi.mock("@/lib/mitm/autoSetupForProvider", () => ({ autoSetupMitmForProvider: vi.fn() }));
vi.mock("@/lib/auth/spawnRouteAuth", () => ({
  requireSpawnRouteAuth: vi.fn(async () => ({ ok: true })),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { "Content-Type": "application/json" },
      }),
  },
}));

const kiroMocks = vi.hoisted(() => ({
  exchangeSocialCode: vi.fn(),
  extractEmailFromJWT: vi.fn(() => "user@example.com"),
}));

vi.mock("@/lib/oauth/services/kiro", () => ({
  KiroService: vi.fn(() => kiroMocks),
}));

const buildModelsListMock = vi.fn();
vi.mock("../../src/app/api/v1/models/route.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, buildModelsList: (...args) => buildModelsListMock(...args) };
});

const requestLogMocks = vi.hoisted(() => ({
  listRequestLogSessions: vi.fn(),
}));

vi.mock("open-sse/utils/requestLogger.js", () => ({
  listRequestLogSessions: (...args) => requestLogMocks.listRequestLogSessions(...args),
}));

const usageStreamMocks = vi.hoisted(() => ({
  getUsageStats: vi.fn(),
  getActiveRequests: vi.fn(),
  saveRequestUsage: vi.fn(() => Promise.resolve()),
  statsEmitter: {
    on: vi.fn(),
    off: vi.fn(),
  },
}));

vi.mock("@/lib/usageDb", () => usageStreamMocks);

const handleChatMock = vi.fn();
vi.mock("@/sse/handlers/chat.js", () => ({
  handleChat: (...args) => handleChatMock(...args),
}));

vi.mock("open-sse/utils/clientDetector.js", () => ({
  detectClientTool: () => null,
  isNativePassthrough: () => false,
}));

// ── 1. v1/models/info webFetch endpoint ─────────────────────────────────────

describe("round-5: v1/models/info webFetch endpoint", () => {
  it("uses /v1/web/fetch for webFetch kind", () => {
    expect(read("src/app/api/v1/models/info/route.js")).toContain('webFetch: "/v1/web/fetch"');
  });
});

// ── 2. availability clearCooldown ───────────────────────────────────────────

describe("round-5: availability clearCooldown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localDbMocks.updateProviderConnection.mockResolvedValue({});
  });

  it("does not reset testStatus when clearing a per-model lock", async () => {
    localDbMocks.getProviderConnections.mockResolvedValue([
      {
        id: "c1",
        provider: "openai",
        testStatus: "unavailable",
        "modelLock_gpt-4": "2099-01-01T00:00:00.000Z",
      },
    ]);

    const { POST } = await import("../../src/app/api/models/availability/route.js");
    const res = await POST({
      json: async () => ({ action: "clearCooldown", provider: "openai", model: "gpt-4" }),
    });
    expect(res.status).toBe(200);
    expect(localDbMocks.updateProviderConnection).toHaveBeenCalledWith("c1", {
      "modelLock_gpt-4": null,
    });
  });

  it("resets testStatus when clearing __all cooldown", async () => {
    localDbMocks.getProviderConnections.mockResolvedValue([
      {
        id: "c1",
        provider: "openai",
        testStatus: "unavailable",
        modelLock___all: "2099-01-01T00:00:00.000Z",
      },
    ]);

    const { POST } = await import("../../src/app/api/models/availability/route.js");
    await POST({
      json: async () => ({ action: "clearCooldown", provider: "openai", model: "__all" }),
    });

    expect(localDbMocks.updateProviderConnection).toHaveBeenCalledWith("c1", {
      modelLock___all: null,
      testStatus: "active",
      lastError: null,
      lastErrorAt: null,
      backoffLevel: 0,
    });
  });
});

// ── 3. usage connection 422 ─────────────────────────────────────────────────

describe("round-5: usage connection unsupported", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 422 for unsupported connection types", async () => {
    localDbMocks.getProviderConnectionById.mockResolvedValue({
      id: "c1",
      provider: "some-provider",
      authType: "apikey",
    });

    const { GET } = await import("../../src/app/api/usage/[connectionId]/route.js");
    const res = await GET(new Request("http://localhost/api/usage/c1"), {
      params: Promise.resolve({ connectionId: "c1" }),
    });

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toContain("not available");
  });
});

// ── 4. request-logs sessions limit validation ───────────────────────────────

describe("round-5: request-logs sessions limit", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 400 for invalid limit", async () => {
    const { GET } = await import("../../src/app/api/request-logs/sessions/route.js");
    const res = await GET({ url: "http://localhost/api/request-logs/sessions?limit=abc" });
    expect(res.status).toBe(400);
    expect(requestLogMocks.listRequestLogSessions).not.toHaveBeenCalled();
  });

  it("passes valid limit to listRequestLogSessions", async () => {
    requestLogMocks.listRequestLogSessions.mockResolvedValue({ sessions: [] });
    const { GET } = await import("../../src/app/api/request-logs/sessions/route.js");
    const res = await GET({ url: "http://localhost/api/request-logs/sessions?limit=25" });
    expect(res.status).toBe(200);
    expect(requestLogMocks.listRequestLogSessions).toHaveBeenCalledWith(25);
  });
});

// ── 5. oauth poll-status consumed grace ─────────────────────────────────────

describe("round-5: oauth poll-status grace", () => {
  beforeEach(() => vi.clearAllMocks());

  it("consumes session instead of clearing immediately on done", async () => {
    oauthServerMocks.getCodexSessionStatus.mockReturnValue({
      status: "done",
      connectionId: "conn-1",
    });

    const { GET } = await import("../../src/app/api/oauth/[provider]/[action]/route.js");
    const res = await GET(
      { url: "http://localhost/api/oauth/codex/poll-status?state=abc" },
      { params: Promise.resolve({ provider: "codex", action: "poll-status" }) },
    );

    expect(res.status).toBe(200);
    expect(oauthServerMocks.consumeCodexSession).toHaveBeenCalledWith("abc");
    expect(oauthServerMocks.clearCodexSession).not.toHaveBeenCalled();
  });

  it("consumeCodexSession marks consumed and schedules delayed clear", async () => {
    vi.useFakeTimers();
    const { registerCodexSession, getCodexSessionStatus, consumeCodexSession, OAUTH_POLL_STATUS_GRACE_MS } =
      await vi.importActual("../../src/lib/oauth/utils/server.js");

    registerCodexSession({ state: "s1", codeVerifier: "v", redirectUri: "http://localhost/cb" });
    const session = getCodexSessionStatus("s1");
    session.status = "done";

    consumeCodexSession("s1");
    expect(getCodexSessionStatus("s1")?.consumed).toBe(true);

    vi.advanceTimersByTime(OAUTH_POLL_STATUS_GRACE_MS);
    expect(getCodexSessionStatus("s1")).toBeNull();
    vi.useRealTimers();
  });
});

// ── 6. v1beta path parser unrecognized action ───────────────────────────────

describe("round-5: v1beta path parser", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    await import("../../open-sse/translator/request/gemini-to-openai.js");
  });

  it("returns 400 for unrecognized action suffix", async () => {
    const { POST } = await import("../../src/app/api/v1beta/models/[...path]/route.js");
    const res = await POST(
      new Request("http://localhost/api/v1beta/models/gemini-pro:unknownAction", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
      }),
      { params: Promise.resolve({ path: ["gemini-pro:unknownAction"] }) },
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toMatch(/Unrecognized action suffix/i);
    expect(handleChatMock).not.toHaveBeenCalled();
  });
});

// ── 7. kiro social-exchange expiresIn guard ─────────────────────────────────

describe("round-5: kiro social-exchange expiresIn", () => {
  it("guards expiresIn like main oauth route", () => {
    const src = read("src/app/api/oauth/kiro/social-exchange/route.js");
    expect(src).toMatch(/expiresAt:\s*tokenData\.expiresIn\s*\?/);
    expect(src).toMatch(/:\s*null/);
  });
});

// ── 8. count_tokens estimate ────────────────────────────────────────────────

describe("round-5: count_tokens estimate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeAuthMock.mockResolvedValue({ ok: true });
  });

  it("includes system, tools, and non-text parts", async () => {
    const { POST } = await import("../../src/app/api/v1/messages/count_tokens/route.js");
    const res = await POST(
      new Request("http://localhost/v1/messages/count_tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system: "You are helpful.",
          tools: [{ name: "get_weather", input_schema: { type: "object" } }],
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Hello" },
                { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
              ],
            },
          ],
        }),
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.input_tokens).toBeGreaterThan(5);
  });
});

// ── 9. v1beta models filtered list ──────────────────────────────────────────

describe("round-5: v1beta models list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeAuthMock.mockResolvedValue({ ok: true });
    buildModelsListMock.mockResolvedValue([
      { id: "openai/gpt-4o", owned_by: "openai" },
    ]);
  });

  it("uses buildModelsList instead of static PROVIDER_MODELS dump", async () => {
    const { GET } = await import("../../src/app/api/v1beta/models/route.js");
    const res = await GET(new Request("http://localhost/api/v1beta/models"));
    expect(res.status).toBe(200);
    expect(buildModelsListMock).toHaveBeenCalledWith(["llm"]);

    const body = await res.json();
    expect(body.models).toHaveLength(1);
    expect(body.models[0].name).toBe("models/openai/gpt-4o");
  });
});

// ── 10. usage stats optional labels ────────────────────────────────────────

describe("round-5: usage stats optional labels", () => {
  it("saveUsageStats tolerates synchronous persistence failure", async () => {
    usageStreamMocks.saveRequestUsage.mockImplementationOnce(() => { throw new Error("db down"); });
    const { saveUsageStats } = await import("../../open-sse/handlers/chatCore/requestDetail.js?sync-persist-failure");
    expect(() => saveUsageStats({
      provider: "openai",
      model: "gpt-test",
      tokens: { prompt_tokens: 1, completion_tokens: 2 },
    })).not.toThrow();
  });

  it("saveUsageStats tolerates missing optional labels", async () => {
    const { saveUsageStats } = await import("../../open-sse/handlers/chatCore/requestDetail.js?optional-labels");
    expect(() => saveUsageStats({
      provider: undefined,
      model: "gpt-test",
      tokens: { prompt_tokens: 1, completion_tokens: 2 },
      connectionId: 12345,
    })).not.toThrow();
    expect(usageStreamMocks.saveRequestUsage).toHaveBeenCalledWith(expect.objectContaining({
      provider: "unknown",
      model: "gpt-test",
    }));
  });
});

// ── 11. usage stream no stale merge ─────────────────────────────────────────

describe("round-5: usage stream", () => {
  beforeEach(() => {
    usageStreamMocks.getUsageStats.mockResolvedValue({ activeRequests: [], recentRequests: [] });
    usageStreamMocks.statsEmitter.on.mockClear();
    usageStreamMocks.statsEmitter.off.mockClear();
  });

  it("does not merge cachedStats with partial activeRequests", () => {
    const src = read("src/app/api/usage/stream/route.js");
    expect(src).not.toMatch(/\.\.\.state\.cachedStats,\s*activeRequests/);
    expect(src).toContain("const stats = await getUsageStats()");
  });

  it("removes usage stream listeners when the request aborts", async () => {
    const { GET } = await import("../../src/app/api/usage/stream/route.js?abort-cleanup");
    const abortController = new AbortController();
    const req = new Request("http://localhost/api/usage/stream", { signal: abortController.signal });

    const response = await GET(req);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");

    await Promise.resolve();
    expect(usageStreamMocks.statsEmitter.on).toHaveBeenCalledWith("update", expect.any(Function));
    expect(usageStreamMocks.statsEmitter.on).toHaveBeenCalledWith("pending", expect.any(Function));

    abortController.abort();

    expect(usageStreamMocks.statsEmitter.off).toHaveBeenCalledWith("update", expect.any(Function));
    expect(usageStreamMocks.statsEmitter.off).toHaveBeenCalledWith("pending", expect.any(Function));
    await response.body.cancel();
  });
});

// ── 12. importDb validation ─────────────────────────────────────────────────

describe("round-5: importDb validation", () => {
  const originalDataDir = process.env.DATA_DIR;
  let tempDir;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-r5-import-"));
    process.env.DATA_DIR = tempDir;
    try { global._dbAdapter?.instance?.close?.(); } catch { /* ignore */ }
    delete global._dbAdapter;
    vi.resetModules();
    const db = await import("../../src/lib/db/index.js");
    await db.initDb();
  });

  afterAll(() => {
    try { global._dbAdapter?.instance?.close?.(); } catch { /* ignore */ }
    delete global._dbAdapter;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("rejects empty payload before wiping", async () => {
    const { setModelAlias, getModelAliases, importDb } = await import("../../src/lib/db/index.js");
    await setModelAlias("keep", "value");
    await expect(importDb({})).rejects.toThrow(/at least one non-empty section/i);
    expect((await getModelAliases()).keep).toBe("value");
  });

  it("preserves priority 0 on import", async () => {
    const { importDb, getProviderConnections } = await import("../../src/lib/db/index.js");
    await importDb({
      providerConnections: [
        {
          id: "p0",
          provider: "openai",
          authType: "apikey",
          priority: 0,
          isActive: true,
        },
      ],
    });
    const conn = (await getProviderConnections()).find((c) => c.id === "p0");
    expect(conn.priority).toBe(0);
  });
});
