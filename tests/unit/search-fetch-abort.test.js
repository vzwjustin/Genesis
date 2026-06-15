import { describe, it, expect, vi, beforeEach } from "vitest";

const proxyAwareFetch = vi.hoisted(() => vi.fn());

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => proxyAwareFetch(...args),
  buildProxyOptionsFromCredentials: () => null,
}));

function abortError() {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}

describe("search/fetch client abort propagation", () => {
  beforeEach(() => {
    vi.resetModules();
    proxyAwareFetch.mockReset();
  });

  it("fetch core returns 499 for a client-aborted upstream fetch", async () => {
    proxyAwareFetch.mockImplementation(async (_url, init) => {
      expect(init.signal.aborted).toBe(true);
      throw abortError();
    });

    const { handleFetchCore } = await import("../../open-sse/handlers/fetch/index.js");
    const controller = new AbortController();
    controller.abort();

    const result = await handleFetchCore({
      url: "https://example.com/page",
      provider: "jina-reader",
      providerConfig: { timeoutMs: 1000 },
      credentials: { apiKey: "key" },
      signal: controller.signal,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(499);
    expect(result.error).toBe("Request aborted");
  });

  it("dedicated search returns 499 for a client-aborted provider request", async () => {
    proxyAwareFetch.mockImplementation(async (_url, init) => {
      expect(init.signal.aborted).toBe(true);
      throw abortError();
    });

    const { handleSearchCore } = await import("../../open-sse/handlers/search/index.js");
    const controller = new AbortController();
    controller.abort();

    const result = await handleSearchCore({
      body: { query: "hello" },
      provider: { id: "tavily" },
      providerConfig: {
        authType: "apiKey",
        baseUrl: "https://api.tavily.com/search",
        defaultMaxResults: 5,
        maxMaxResults: 10,
        searchTypes: ["web"],
        timeoutMs: 1000,
      },
      credentials: { apiKey: "key" },
      signal: controller.signal,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(499);
  });

  it("chat-search fallback returns 499 for a client-aborted provider request", async () => {
    proxyAwareFetch.mockImplementation(async (_url, init) => {
      expect(init.signal.aborted).toBe(true);
      throw abortError();
    });

    const { handleChatSearch } = await import("../../open-sse/handlers/search/chatSearch.js");
    const controller = new AbortController();
    controller.abort();

    const result = await handleChatSearch({
      provider: "openai",
      query: "hello",
      model: "gpt-4o-search-preview",
      credentials: { apiKey: "key" },
      signal: controller.signal,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(499);
  });
});
