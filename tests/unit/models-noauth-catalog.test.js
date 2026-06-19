import { describe, it, expect, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(async () => []),
  getCombos: vi.fn(async () => []),
  getCustomModels: vi.fn(async () => []),
  getModelAliases: vi.fn(async () => ({})),
}));

const fetchMock = vi.hoisted(() => vi.fn(async () => new Response(JSON.stringify({
  data: [
    { id: "big-pickle" },
    { id: "paid-model" },
    { id: "qwen3.6-plus-free" },
  ],
}), { status: 200, headers: { "Content-Type": "application/json" } })));

vi.mock("@/lib/localDb", () => dbMocks);
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: vi.fn(async () => ({})) }));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({})),
}));
vi.mock("../../open-sse/utils/proxyFetch.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, proxyAwareFetch: fetchMock };
});

const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");

describe("/v1/models no-auth catalog", () => {
  it("lists no-auth LLM provider models without saved connections", async () => {
    const { models } = await buildModelsList(["llm"]);
    const ids = models.map((m) => m.id);

    expect(ids).toContain("oc/big-pickle");
    expect(ids).toContain("oc/qwen3.6-plus-free");
    expect(ids).not.toContain("oc/paid-model");
  });
});
