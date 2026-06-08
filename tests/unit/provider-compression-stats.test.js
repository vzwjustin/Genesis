import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  rows: [],
}));

vi.mock("../../src/lib/db/driver.js", () => ({
  getAdapter: vi.fn(async () => ({
    all: vi.fn((_sql, _params) => mocks.rows),
    run: vi.fn(),
    get: vi.fn(),
  })),
}));

describe("getProviderCompressionStats", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.rows = [];
  });

  it("aggregates compression events by provider and subsystem", async () => {
    mocks.rows = [
      {
        timestamp: "2026-06-08T10:00:00.000Z",
        provider: "anthropic",
        subsystem: "rtk",
        bytes_before: 1000,
        bytes_after: 400,
        level: null,
      },
      {
        timestamp: "2026-06-08T10:01:00.000Z",
        provider: "anthropic",
        subsystem: "headroom",
        bytes_before: 800,
        bytes_after: 500,
        level: null,
      },
      {
        timestamp: "2026-06-08T10:02:00.000Z",
        provider: "openai",
        subsystem: "caveman",
        bytes_before: 0,
        bytes_after: 0,
        level: "full",
      },
      {
        timestamp: "2026-06-08T10:03:00.000Z",
        provider: null,
        subsystem: "rtk",
        bytes_before: 200,
        bytes_after: 100,
        level: null,
      },
    ];

    const { getProviderCompressionStats } = await import("../../src/lib/compressionStats.js");
    const stats = await getProviderCompressionStats("7d");

    expect(stats.requests).toBe(4);
    expect(stats.providers).toHaveLength(3);

    const anthropic = stats.providers.find((p) => p.provider === "anthropic");
    expect(anthropic).toMatchObject({
      events: 2,
      bytesSaved: 900,
      rtk: { events: 1, bytesSaved: 600 },
      headroom: { events: 1, bytesSaved: 300 },
      caveman: { events: 0, injections: 0 },
    });

    const openai = stats.providers.find((p) => p.provider === "openai");
    expect(openai).toMatchObject({
      events: 1,
      bytesSaved: 0,
      caveman: { events: 1, injections: 1 },
    });

    const unknown = stats.providers.find((p) => p.provider === "unknown");
    expect(unknown?.rtk.bytesSaved).toBe(100);
  });
});

describe("GET /api/compression/by-provider", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns provider compression stats", async () => {
    vi.doMock("@/lib/compressionStats", () => ({
      getProviderCompressionStats: vi.fn(async () => ({
        period: "7d",
        requests: 2,
        providers: [{ provider: "anthropic", events: 2, bytesSaved: 900 }],
      })),
    }));

    const { GET } = await import("../../src/app/api/compression/by-provider/route.js");
    const res = await GET({ url: "http://localhost/api/compression/by-provider?period=7d" });
    const body = await res.json();

    expect(body.period).toBe("7d");
    expect(body.providers[0].provider).toBe("anthropic");
    expect(body.updatedAt).toBeTruthy();
  });
});
