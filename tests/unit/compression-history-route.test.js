import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  json: vi.fn((body, init) => ({ status: init?.status || 200, body })),
  getCompressionStatsHistory: vi.fn(async () => [
    {
      id: 1,
      timestamp: "2026-06-08T12:00:00.000Z",
      subsystem: "rtk",
      bytes_before: 1000,
      bytes_after: 200,
      filter_hits: '["git-diff"]',
      level: null,
    },
  ]),
  resetCompressionStats: vi.fn(async () => ({ updatedAt: null, tools: {} })),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: mocks.json },
}));

vi.mock("@/lib/compressionStats", () => ({
  getCompressionStatsHistory: mocks.getCompressionStatsHistory,
  resetCompressionStats: mocks.resetCompressionStats,
}));

describe("compression history API", () => {
  it("GET returns normalized history rows", async () => {
    const { GET } = await import("../../src/app/api/compression/history/route.js");
    const req = { url: "http://localhost/api/compression/history?subsystem=rtk&limit=50" };

    const response = await GET(req);

    expect(response.status).toBe(200);
    expect(response.body.rows).toHaveLength(1);
    expect(response.body.rows[0].bytesSaved).toBe(800);
    expect(mocks.getCompressionStatsHistory).toHaveBeenCalledWith({
      subsystem: "rtk",
      since: undefined,
      limit: 50,
    });
  });

  it("POST reset clears aggregate stats", async () => {
    const { POST } = await import("../../src/app/api/compression/reset/route.js");

    const response = await POST();

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(mocks.resetCompressionStats).toHaveBeenCalledOnce();
  });
});
