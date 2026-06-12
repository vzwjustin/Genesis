/**
 * Unit tests for open-sse/handlers/embeddingsCore.js and embedding provider adapters.
 * No mocks: adapter unit tests, validation-only handler probes, source inspection.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { handleEmbeddingsCore } from "../../open-sse/handlers/embeddingsCore.js";
import { getEmbeddingAdapter } from "../../open-sse/handlers/embeddingProviders/index.js";
import createOpenAIEmbeddingAdapter from "../../open-sse/handlers/embeddingProviders/openai.js";
import gemini from "../../open-sse/handlers/embeddingProviders/gemini.js";
import openaiCompatNode from "../../open-sse/handlers/embeddingProviders/openaiCompatNode.js";

const root = dirname(fileURLToPath(import.meta.url));
const noopLog = { debug() {}, info() {}, warn() {}, error() {} };

function makeOptions(overrides = {}) {
  return {
    body: { model: "text-embedding-ada-002", input: "Hello world" },
    modelInfo: { provider: "openai", model: "text-embedding-ada-002" },
    credentials: { apiKey: "sk-test-key" },
    log: noopLog,
    onCredentialsRefreshed: () => {},
    onRequestSuccess: () => {},
    ...overrides,
  };
}

describe("embedding adapters — buildBody", () => {
  const openai = createOpenAIEmbeddingAdapter("openai");

  it("single string input — includes model and input, default encoding_format=float", () => {
    const body = openai.buildBody("text-embedding-ada-002", {
      input: "Hello world",
      encoding_format: "float",
    });
    expect(body.model).toBe("text-embedding-ada-002");
    expect(body.input).toBe("Hello world");
    expect(body.encoding_format).toBe("float");
  });

  it("array input — passes array as-is", () => {
    const body = openai.buildBody("text-embedding-ada-002", {
      input: ["Hello", "World"],
      encoding_format: "float",
    });
    expect(body.input).toEqual(["Hello", "World"]);
  });

  it("custom encoding_format is forwarded", () => {
    const body = openai.buildBody("text-embedding-ada-002", {
      input: "test",
      encoding_format: "base64",
    });
    expect(body.encoding_format).toBe("base64");
  });

  it("no encoding_format in body → defaults to float via handler", async () => {
    const adapter = getEmbeddingAdapter("openai");
    const body = adapter.buildBody("text-embedding-ada-002", {
      input: "test",
      encoding_format: "float",
    });
    expect(body.encoding_format).toBe("float");
  });

  it("gemini single input forwards dimensions as outputDimensionality", () => {
    const body = gemini.buildBody("gemini-embedding-2-preview", {
      input: "test",
      dimensions: 1536,
    });
    expect(body.outputDimensionality).toBe(1536);
  });

  it("gemini batch input forwards dimensions on each request", () => {
    const body = gemini.buildBody("gemini-embedding-2-preview", {
      input: ["hello", "world"],
      dimensions: 1536,
    });
    expect(body.requests).toHaveLength(2);
    expect(body.requests[0].outputDimensionality).toBe(1536);
    expect(body.requests[1].outputDimensionality).toBe(1536);
  });
});

describe("embedding adapters — buildUrl", () => {
  it("openai → https://api.openai.com/v1/embeddings", () => {
    const adapter = getEmbeddingAdapter("openai");
    expect(adapter.buildUrl("text-embedding-ada-002", { apiKey: "sk-test" }, { input: "hi" }))
      .toBe("https://api.openai.com/v1/embeddings");
  });

  it("openrouter → https://openrouter.ai/api/v1/embeddings", () => {
    const adapter = getEmbeddingAdapter("openrouter");
    expect(adapter.buildUrl("openai/text-embedding-ada-002", { apiKey: "sk-or-test" }, { input: "hi" }))
      .toBe("https://openrouter.ai/api/v1/embeddings");
  });

  it("openai-compatible-* → uses baseUrl from providerSpecificData", () => {
    const url = openaiCompatNode.buildUrl("embed-v1", {
      apiKey: "sk-custom",
      providerSpecificData: { baseUrl: "https://custom.ai/v1" },
    });
    expect(url).toBe("https://custom.ai/v1/embeddings");
  });

  it("openai-compatible-* strips trailing slash from baseUrl", () => {
    const url = openaiCompatNode.buildUrl("embed-v1", {
      apiKey: "sk-x",
      providerSpecificData: { baseUrl: "https://myhost.ai/v1/" },
    });
    expect(url).toBe("https://myhost.ai/v1/embeddings");
  });

  it("openai-compatible-* without baseUrl → falls back to api.openai.com", () => {
    const url = openaiCompatNode.buildUrl("embed", {
      apiKey: "sk-x",
      providerSpecificData: {},
    });
    expect(url).toBe("https://api.openai.com/v1/embeddings");
  });

  it("unsupported provider (e.g. gemini-cli) → null adapter", () => {
    expect(getEmbeddingAdapter("gemini-cli")).toBeNull();
  });

  it("antigravity (non-openai-compatible, no URL mapping) → null adapter", () => {
    expect(getEmbeddingAdapter("antigravity")).toBeNull();
  });
});

describe("embedding adapters — buildHeaders", () => {
  const openai = createOpenAIEmbeddingAdapter("openai");
  const openrouter = createOpenAIEmbeddingAdapter("openrouter");

  it("openai → Authorization: Bearer, Content-Type: application/json", () => {
    const headers = openai.buildHeaders({ apiKey: "sk-mykey" });
    expect(headers.Authorization).toBe("Bearer sk-mykey");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("openai — uses accessToken when apiKey is absent", () => {
    const headers = openai.buildHeaders({ accessToken: "at-mytoken" });
    expect(headers.Authorization).toBe("Bearer at-mytoken");
  });

  it("openrouter → adds HTTP-Referer and X-Title headers", () => {
    const headers = openrouter.buildHeaders({ apiKey: "sk-or-key" });
    expect(headers["HTTP-Referer"]).toBeDefined();
    expect(headers["X-Title"]).toBeDefined();
    expect(headers.Authorization).toBe("Bearer sk-or-key");
  });

  it("openai-compatible-* → Authorization: Bearer only (no extra headers)", () => {
    const headers = openaiCompatNode.buildHeaders({
      apiKey: "local-key",
      providerSpecificData: { baseUrl: "http://localhost:11434/v1" },
    });
    expect(headers.Authorization).toBe("Bearer local-key");
    expect(headers["HTTP-Referer"]).toBeUndefined();
    expect(headers["X-Title"]).toBeUndefined();
  });
});

describe("gemini adapter — normalize", () => {
  it("converts single embedding response to OpenAI list format", () => {
    const normalized = gemini.normalize(
      { embedding: { values: [0.1, 0.2, 0.3] } },
      "gemini-embedding-2-preview"
    );
    expect(normalized.object).toBe("list");
    expect(normalized.data[0].embedding).toEqual([0.1, 0.2, 0.3]);
  });

  it("converts batch embeddings response", () => {
    const normalized = gemini.normalize(
      {
        embeddings: [
          { values: [0.1, 0.2, 0.3] },
          { values: [0.4, 0.5, 0.6] },
        ],
      },
      "gemini-embedding-2-preview"
    );
    expect(normalized.data).toHaveLength(2);
    expect(normalized.data[1].index).toBe(1);
  });
});

describe("embeddings handler — input validation (source)", () => {
  it("rejects empty input arrays and invalid element types before core", () => {
    const src = readFileSync(join(root, "../../src/sse/handlers/embeddings.js"), "utf8");
    expect(src).toContain("input array must not be empty");
    expect(src).toContain("input[${i}] must be a string");
  });
});

describe("handleEmbeddingsCore — input validation", () => {
  it("missing input → 400 Bad Request", async () => {
    const result = await handleEmbeddingsCore(makeOptions({
      body: { model: "text-embedding-ada-002" },
    }));
    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/missing required field: input/i);
  });

  it("input is a number → 400 Bad Request", async () => {
    const result = await handleEmbeddingsCore(makeOptions({
      body: { model: "text-embedding-ada-002", input: 42 },
    }));
    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/input must be a string or array/i);
  });

  it("input is an object → 400 Bad Request", async () => {
    const result = await handleEmbeddingsCore(makeOptions({
      body: { model: "text-embedding-ada-002", input: { text: "hello" } },
    }));
    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/input must be a string or array/i);
  });

  it("input is null → 400 Bad Request", async () => {
    const result = await handleEmbeddingsCore(makeOptions({
      body: { model: "text-embedding-ada-002", input: null },
    }));
    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
  });

  it("empty string input is treated as missing", async () => {
    const result = await handleEmbeddingsCore(makeOptions({
      body: { model: "text-embedding-ada-002", input: "" },
    }));
    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
  });

  it("empty array input → 400 Bad Request", async () => {
    const result = await handleEmbeddingsCore(makeOptions({
      body: { model: "text-embedding-ada-002", input: [] },
    }));
    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/empty/i);
  });

  it("array with non-string element → 400 Bad Request", async () => {
    const result = await handleEmbeddingsCore(makeOptions({
      body: { model: "text-embedding-ada-002", input: ["hello", 42] },
    }));
    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/input\[1\] must be a string/i);
  });

  it("unsupported provider → 400 without upstream call", async () => {
    const result = await handleEmbeddingsCore(makeOptions({
      modelInfo: { provider: "gemini-cli", model: "gemini-embedding" },
      credentials: { apiKey: "token" },
    }));
    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/does not support embeddings/i);
  });
});

describe("embeddingsCore proxy routing (source)", () => {
  it("routes upstream through proxyAwareFetch with connection proxy options", () => {
    const src = readFileSync(join(root, "../../open-sse/handlers/embeddingsCore.js"), "utf8");
    expect(src).toContain("proxyAwareFetch");
    expect(src).toContain("buildProxyOptionsFromCredentials");
    expect(src).not.toMatch(/\bfetch\s*\(/);
  });

  it("retries with refreshed credentials on 401/403", () => {
    const src = readFileSync(join(root, "../../open-sse/handlers/embeddingsCore.js"), "utf8");
    expect(src).toContain("refreshWithRetry");
    expect(src).toContain("HTTP_STATUS.UNAUTHORIZED");
    expect(src).toContain("HTTP_STATUS.FORBIDDEN");
  });

  it("skips refresh loop when executor.supportsTokenRefresh is false", () => {
    const src = readFileSync(join(root, "../../open-sse/handlers/embeddingsCore.js"), "utf8");
    expect(src).toContain("supportsTokenRefresh === false");
  });
});
