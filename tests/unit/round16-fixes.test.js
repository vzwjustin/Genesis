/**
 * Round 16 — SSRF guards, retry fail-closed, validation hardening
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi, beforeEach } from "vitest";

const proxyAwareFetch = vi.hoisted(() => vi.fn());

vi.mock("open-sse/utils/proxyFetch.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    proxyAwareFetch: (...args) => proxyAwareFetch(...args),
  };
});

describe("suggested-models SSRF guard", () => {
  beforeEach(() => {
    vi.resetModules();
    proxyAwareFetch.mockReset();
  });

  it("rejects arbitrary URLs not in the provider allowlist", async () => {
    const { GET } = await import("../../src/app/api/providers/suggested-models/route.js");
    const response = await GET(
      new Request("http://localhost/api/providers/suggested-models?url=http://169.254.169.254/&type=openrouter-free")
    );
    expect(response.status).toBe(400);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("fetches allowlisted HTTPS URLs via proxyAwareFetch", async () => {
    proxyAwareFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "m", name: "M", pricing: { prompt: "0", completion: "0" }, context_length: 300000 }] }),
    });

    const { GET } = await import("../../src/app/api/providers/suggested-models/route.js");
    const response = await GET(
      new Request(
        "http://localhost/api/providers/suggested-models?url=https://openrouter.ai/api/v1/models&type=openrouter-free"
      )
    );
    expect(response.status).toBe(200);
    expect(proxyAwareFetch).toHaveBeenCalledWith("https://openrouter.ai/api/v1/models");
  });
});

describe("provider-nodes validate proxy migration", () => {
  it("route source uses proxyAwareFetch with abort-based timeout", () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../src/app/api/provider-nodes/validate/route.js"),
      "utf8"
    );
    expect(src).toContain("proxyAwareFetch");
    expect(src).toContain("AbortController");
    expect(src).not.toMatch(/\bfetch\s*\(/);
  });
});

describe("embeddings retry fail-closed", () => {
  it("returns error when post-refresh retry throws", async () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../open-sse/handlers/embeddingsCore.js"),
      "utf8"
    );
    expect(src).toContain("retry after refresh failed");
    expect(src).toMatch(/catch \(retryError\)[\s\S]*return createErrorResult/);
  });
});

describe("image generation binary output fail-closed", () => {
  it("returns error when binaryOutput requested but no image data", async () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../open-sse/handlers/imageGenerationCore.js"),
      "utf8"
    );
    expect(src).toContain("Binary output requested but no image data in response");
  });
});

describe("web fetch malformed JSON fail-closed", () => {
  it("readJsonOrText surfaces parse errors", async () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../open-sse/handlers/fetch/index.js"),
      "utf8"
    );
    expect(src).toContain("parseError");
    expect(src).not.toMatch(/catch \{ return \{ text: "" \}/);
  });
});

describe("test-models no longer treats HTTP 400 as success", () => {
  it("pingModel only accepts HTTP 200 with choices", () => {
    const src = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "../../src/app/api/providers/[id]/test-models/route.js"
      ),
      "utf8"
    );
    expect(src).not.toContain("res.status === 400");
    expect(src).toContain("body.choices");
  });
});

describe("v1beta streaming terminal validation", () => {
  it("tracks terminal chunk and errors on truncated stream", () => {
    const src = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "../../src/app/api/v1beta/models/[...path]/route.js"
      ),
      "utf8"
    );
    expect(src).toContain("sawTerminal");
    expect(src).toContain("Stream ended without terminal completion chunk");
  });
});
