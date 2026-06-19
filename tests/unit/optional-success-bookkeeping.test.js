import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());

vi.mock("../../open-sse/utils/proxyFetch.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    proxyAwareFetch: fetchMock,
  };
});

const { handleEmbeddingsCore } = await import("../../open-sse/handlers/embeddingsCore.js");
const { handleImageGenerationCore } = await import("../../open-sse/handlers/imageGenerationCore.js");

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe("optional success bookkeeping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not fail a successful embeddings response when onRequestSuccess throws", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      data: [{ embedding: [0.1, 0.2], index: 0 }],
      usage: { prompt_tokens: 1, total_tokens: 1 },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const result = await handleEmbeddingsCore({
      body: { model: "openai/text-embedding-ada-002", input: "hello" },
      modelInfo: { provider: "openai", model: "text-embedding-ada-002" },
      credentials: { apiKey: "sk-test" },
      log,
      onRequestSuccess: async () => { throw new Error("db down"); },
    });

    expect(result.success).toBe(true);
    expect(result.response.status).toBe(200);
  });

  it("does not fail a successful image response when onRequestSuccess throws", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      created: 1,
      data: [{ url: "https://example.com/image.png" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const result = await handleImageGenerationCore({
      body: { model: "openai/dall-e-3", prompt: "cat" },
      modelInfo: { provider: "openai", model: "dall-e-3" },
      credentials: { apiKey: "sk-test" },
      log,
      onRequestSuccess: async () => { throw new Error("db down"); },
    });

    expect(result.success).toBe(true);
    expect(result.response.status).toBe(200);
  });
});
