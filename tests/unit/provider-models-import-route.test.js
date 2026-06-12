import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = {
  getProviderConnectionById: vi.fn(),
  autoImportProviderModels: vi.fn(),
};

vi.mock("@/models", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
}));

vi.mock("../../src/lib/models/autoImportProviderModels.js", () => ({
  autoImportProviderModels: mocks.autoImportProviderModels,
}));

describe("POST /api/providers/[id]/models/import", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("returns 200 with warning when provider session expired", async () => {
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
    expect(data.ok).toBe(true);
    expect(data.warning).toContain("session expired");
  });

  it("returns 200 for upstream listing warnings (custom resolver fail-open)", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({ id: "conn-4", provider: "gemini-cli" });
    mocks.autoImportProviderModels.mockResolvedValue({
      imported: 0,
      total: 0,
      upstreamFailure: true,
      warning: "Failed to fetch Gemini CLI models: 403 forbidden",
    });

    const { POST } = await import("../../src/app/api/providers/[id]/models/import/route.js");
    const res = await POST(null, { params: Promise.resolve({ id: "conn-4" }) });
    expect(res.status).toBe(200);
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
