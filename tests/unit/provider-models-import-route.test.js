import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = {
  getProviderConnectionById: vi.fn(),
  autoImportProviderModels: vi.fn(),
  requireSpawnRouteAuth: vi.fn(async () => ({ ok: true })),
};

vi.mock("@/models", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
}));

vi.mock("../../src/lib/models/autoImportProviderModels.js", () => ({
  autoImportProviderModels: mocks.autoImportProviderModels,
}));

vi.mock("@/lib/auth/spawnRouteAuth", () => ({
  requireSpawnRouteAuth: mocks.requireSpawnRouteAuth,
}));

describe("POST /api/providers/[id]/models/import", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireSpawnRouteAuth.mockResolvedValue({ ok: true });
  });

  it("returns 401 when unauthenticated and never imports", async () => {
    mocks.requireSpawnRouteAuth.mockResolvedValue({ ok: false, error: "Login required", status: 401 });
    const { POST } = await import("../../src/app/api/providers/[id]/models/import/route.js");
    const res = await POST(null, { params: Promise.resolve({ id: "conn-1" }) });

    expect(res.status).toBe(401);
    expect(mocks.autoImportProviderModels).not.toHaveBeenCalled();
  });

  it("returns 404 when connection is missing", async () => {
    mocks.getProviderConnectionById.mockResolvedValue(null);
    const { POST } = await import("../../src/app/api/providers/[id]/models/import/route.js");
    const res = await POST(null, { params: Promise.resolve({ id: "missing" }) });
    expect(res.status).toBe(404);
  });

  it("imports models and returns counts", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({ id: "conn-1", provider: "openai" });
    mocks.autoImportProviderModels.mockResolvedValue({ imported: 3, total: 10 });

    const { POST } = await import("../../src/app/api/providers/[id]/models/import/route.js");
    const res = await POST(null, { params: Promise.resolve({ id: "conn-1" }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.imported).toBe(3);
    expect(mocks.autoImportProviderModels).toHaveBeenCalledWith({ id: "conn-1", provider: "openai" });
  });

  it("returns 200 degraded response when provider session expired", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({ id: "conn-3", provider: "codex" });
    mocks.autoImportProviderModels.mockResolvedValue({
      imported: 0,
      total: 0,
      authFailure: true,
      warning: "Provider session expired — reconnect codex or refresh credentials",
    });

    const { POST } = await import("../../src/app/api/providers/[id]/models/import/route.js");
    const res = await POST(null, { params: Promise.resolve({ id: "conn-3" }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.ok).toBe(false);
    expect(data.status).toBe("degraded");
    expect(data.warning).toContain("session expired");
  });

  it("returns 200 degraded response for upstream listing warnings", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({ id: "conn-4", provider: "gemini-cli" });
    mocks.autoImportProviderModels.mockResolvedValue({
      imported: 0,
      total: 0,
      upstreamFailure: true,
      warning: "Failed to fetch Gemini CLI models: 403 forbidden",
    });

    const { POST } = await import("../../src/app/api/providers/[id]/models/import/route.js");
    const res = await POST(null, { params: Promise.resolve({ id: "conn-4" }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.ok).toBe(false);
    expect(data.status).toBe("degraded");
    expect(data.upstreamFailure).toBe(true);
  });

  it("returns degraded response when auto-import catches an error", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({ id: "conn-5", provider: "openai" });
    mocks.autoImportProviderModels.mockResolvedValue({
      imported: 0,
      error: "network down",
    });

    const { POST } = await import("../../src/app/api/providers/[id]/models/import/route.js");
    const res = await POST(null, { params: Promise.resolve({ id: "conn-5" }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.ok).toBe(false);
    expect(data.status).toBe("degraded");
    expect(data.error).toBe("network down");
  });

  it("returns 400 when upstream listing is unsupported", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({ id: "conn-2", provider: "cursor" });
    mocks.autoImportProviderModels.mockResolvedValue({
      imported: 0,
      total: 0,
      warning: "Provider cursor does not support models listing",
    });

    const { POST } = await import("../../src/app/api/providers/[id]/models/import/route.js");
    const res = await POST(null, { params: Promise.resolve({ id: "conn-2" }) });
    expect(res.status).toBe(400);
  });
});
