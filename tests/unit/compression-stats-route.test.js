import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  json: vi.fn((body, init) => ({ status: init?.status || 200, body })),
  getCompressionStats: vi.fn(async () => ({ tools: { rtk: { hits: 3 } } })),
  getHeadroomProxyStats: vi.fn(async () => ({
    dashboardUrl: "http://localhost:8787/dashboard",
    mcpCompressions: 4,
    tokensSaved: 200,
  })),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: mocks.json },
}));

vi.mock("@/lib/compressionStats", () => ({
  getCompressionStats: mocks.getCompressionStats,
}));

vi.mock("open-sse/rtk/headroom.js", () => ({
  getHeadroomProxyStats: mocks.getHeadroomProxyStats,
}));

vi.mock("@/lib/auth/spawnRouteAuth", () => ({
  requireSpawnRouteAuth: vi.fn(async () => ({ ok: true })),
}));

describe("compression stats API", () => {
  it("returns aggregate compression stats merged with headroom proxy stats", async () => {
    const { GET } = await import("../../src/app/api/compression/stats/route.js");

    const response = await GET({ headers: new Headers() });

    expect(response.status).toBe(200);
    expect(response.body.tools.rtk.hits).toBe(3);
    expect(response.body.headroomProxy.mcpCompressions).toBe(4);
    expect(mocks.getCompressionStats).toHaveBeenCalledOnce();
    expect(mocks.getHeadroomProxyStats).toHaveBeenCalledOnce();
  });
});
