import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getModelAliases: vi.fn(),
  setModelAlias: vi.fn(),
  deleteModelAlias: vi.fn(),
}));

vi.mock("@/models", () => mocks);

// Isolate the route logic under test: stub the auth gate so a plain Request
// (no NextRequest `.cookies`) reaches the alias-conflict handler.
vi.mock("@/lib/auth/spawnRouteAuth", () => ({
  requireSpawnRouteAuth: vi.fn(async () => ({ ok: true })),
}));

describe("PUT /api/models/alias conflict handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 409 when alias maps to a different model", async () => {
    mocks.getModelAliases.mockResolvedValue({ opus: "cc/claude-opus-4-6" });

    const { PUT } = await import("../../src/app/api/models/alias/route.js");
    const req = new Request("http://localhost/api/models/alias", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alias: "opus", model: "openai/gpt-4o" }),
    });

    const res = await PUT(req);
    expect(res.status).toBe(409);
    expect(mocks.setModelAlias).not.toHaveBeenCalled();
  });

  it("allows idempotent update to same model", async () => {
    mocks.getModelAliases.mockResolvedValue({ opus: "cc/claude-opus-4-6" });

    const { PUT } = await import("../../src/app/api/models/alias/route.js");
    const req = new Request("http://localhost/api/models/alias", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alias: "opus", model: "cc/claude-opus-4-6" }),
    });

    const res = await PUT(req);
    expect(res.status).toBe(200);
    expect(mocks.setModelAlias).toHaveBeenCalledWith("opus", "cc/claude-opus-4-6");
  });
});
