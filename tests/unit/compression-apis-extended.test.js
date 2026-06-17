import { beforeEach, describe, it, expect, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderCacheStats: vi.fn(),
  getSearchCacheStats: vi.fn(),
  getFilterLeaderboard: vi.fn(),
  clearCompressionHistory: vi.fn(),
  listRequestLogSessions: vi.fn(),
  requireSpawnRouteAuth: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@/lib/usageDb", () => ({
  getProviderCacheStats: mocks.getProviderCacheStats,
}));

vi.mock("open-sse/handlers/search/cache.js", () => ({
  getSearchCacheStats: mocks.getSearchCacheStats,
}));

vi.mock("@/lib/compressionStats", () => ({
  getFilterLeaderboard: mocks.getFilterLeaderboard,
  clearCompressionHistory: mocks.clearCompressionHistory,
}));

vi.mock("open-sse/utils/requestLogger.js", () => ({
  listRequestLogSessions: mocks.listRequestLogSessions,
}));

// Stub the auth gate (requireSpawnRouteAuth reads NextRequest `.cookies`,
// absent on the plain Request used in these tests).
vi.mock("@/lib/auth/spawnRouteAuth", () => ({
  requireSpawnRouteAuth: mocks.requireSpawnRouteAuth,
}));

describe("extended compression APIs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireSpawnRouteAuth.mockResolvedValue({ ok: true });
  });

  it("GET /api/compression/provider-cache returns aggregated data", async () => {
    mocks.getProviderCacheStats.mockResolvedValue({ requests: 1, hitRate: 100 });
    mocks.getSearchCacheStats.mockReturnValue({ hits: 2, misses: 1 });

    const { GET } = await import("../../src/app/api/compression/provider-cache/route.js");
    const res = await GET({ url: "http://localhost/api/compression/provider-cache?period=7d" });
    const body = await res.json();

    expect(body.providerCache.requests).toBe(1);
    expect(body.searchCache.hits).toBe(2);
  });

  it("GET /api/compression/filter-leaderboard", async () => {
    mocks.getFilterLeaderboard.mockResolvedValue([{ filter: "git-diff", hits: 3, bytesSaved: 900 }]);

    const { GET } = await import("../../src/app/api/compression/filter-leaderboard/route.js");
    const res = await GET({ url: "http://localhost/api/compression/filter-leaderboard" });
    const body = await res.json();

    expect(body.rows[0].filter).toBe("git-diff");
  });

  it("GET /api/compression/provider-cache requires auth", async () => {
    mocks.requireSpawnRouteAuth.mockResolvedValue({ ok: false, error: "Login required", status: 401 });

    const { GET } = await import("../../src/app/api/compression/provider-cache/route.js");
    const res = await GET({ url: "http://localhost/api/compression/provider-cache" });
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("Login required");
    expect(mocks.getProviderCacheStats).not.toHaveBeenCalled();
  });

  it("GET /api/compression/filter-leaderboard requires auth", async () => {
    mocks.requireSpawnRouteAuth.mockResolvedValue({ ok: false, error: "Login required", status: 401 });

    const { GET } = await import("../../src/app/api/compression/filter-leaderboard/route.js");
    const res = await GET({ url: "http://localhost/api/compression/filter-leaderboard" });
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("Login required");
    expect(mocks.getFilterLeaderboard).not.toHaveBeenCalled();
  });

  it("POST /api/compression/history/clear", async () => {
    mocks.clearCompressionHistory.mockResolvedValue(5);

    const { POST } = await import("../../src/app/api/compression/history/clear/route.js");
    const res = await POST();
    const body = await res.json();

    expect(body.deleted).toBe(5);
  });

  it("GET /api/request-logs/sessions", async () => {
    mocks.listRequestLogSessions.mockResolvedValue({ enabled: true, sessions: [{ name: "sess1" }] });

    const { GET } = await import("../../src/app/api/request-logs/sessions/route.js");
    const res = await GET({ url: "http://localhost/api/request-logs/sessions" });
    const body = await res.json();

    expect(body.sessions).toHaveLength(1);
  });
});
