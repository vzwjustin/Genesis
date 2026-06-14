import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = {
  swapProviderConnectionPriorities: vi.fn(),
  requireSpawnRouteAuth: vi.fn(async () => ({ ok: true })),
};

vi.mock("@/models", () => ({
  swapProviderConnectionPriorities: mocks.swapProviderConnectionPriorities,
}));

vi.mock("@/lib/auth/spawnRouteAuth", () => ({
  requireSpawnRouteAuth: mocks.requireSpawnRouteAuth,
}));

describe("POST /api/providers/swap-priority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireSpawnRouteAuth.mockResolvedValue({ ok: true });
  });

  it("returns 401 when unauthenticated and never mutates", async () => {
    mocks.requireSpawnRouteAuth.mockResolvedValue({ ok: false, error: "Login required", status: 401 });
    const { POST } = await import("../../src/app/api/providers/swap-priority/route.js");
    const res = await POST({ json: async () => ({ connectionId1: "conn-a", connectionId2: "conn-b" }) });

    expect(res.status).toBe(401);
    expect(mocks.swapProviderConnectionPriorities).not.toHaveBeenCalled();
  });

  it("returns 400 when connection ids are missing", async () => {
    const { POST } = await import("../../src/app/api/providers/swap-priority/route.js");
    const res = await POST({ json: async () => ({ connectionId1: "conn-a" }) });
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toContain("connectionId1 and connectionId2 are required");
    expect(mocks.swapProviderConnectionPriorities).not.toHaveBeenCalled();
  });

  it("returns success without swap when both ids are identical", async () => {
    const { POST } = await import("../../src/app/api/providers/swap-priority/route.js");
    const res = await POST({
      json: async () => ({ connectionId1: "conn-a", connectionId2: "conn-a" }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(mocks.swapProviderConnectionPriorities).not.toHaveBeenCalled();
  });

  it("returns 404 when connections cannot be swapped", async () => {
    mocks.swapProviderConnectionPriorities.mockResolvedValue(false);

    const { POST } = await import("../../src/app/api/providers/swap-priority/route.js");
    const res = await POST({
      json: async () => ({ connectionId1: "conn-a", connectionId2: "conn-b" }),
    });
    const data = await res.json();

    expect(res.status).toBe(404);
    expect(data.error).toContain("different providers");
    expect(mocks.swapProviderConnectionPriorities).toHaveBeenCalledWith("conn-a", "conn-b");
  });

  it("returns success when swap succeeds", async () => {
    mocks.swapProviderConnectionPriorities.mockResolvedValue(true);

    const { POST } = await import("../../src/app/api/providers/swap-priority/route.js");
    const res = await POST({
      json: async () => ({ connectionId1: "conn-a", connectionId2: "conn-b" }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(mocks.swapProviderConnectionPriorities).toHaveBeenCalledWith("conn-a", "conn-b");
  });
});
