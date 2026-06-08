/**
 * Round 16 — SSRF guards, retry fail-closed, validation hardening
 * No mocks: SSRF rejection probes + source inspection.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const root = dirname(fileURLToPath(import.meta.url));

describe("suggested-models SSRF guard", () => {
  it("rejects arbitrary URLs not in the provider allowlist", async () => {
    const { GET } = await import("../../src/app/api/providers/suggested-models/route.js");
    const response = await GET(
      new Request("http://localhost/api/providers/suggested-models?url=http://169.254.169.254/&type=openrouter-free")
    );
    expect(response.status).toBe(400);
  });

  it("allowlists URLs and uses proxyAwareFetch (source)", () => {
    const src = readFileSync(
      join(root, "../../src/app/api/providers/suggested-models/route.js"),
      "utf8"
    );
    expect(src).toContain("ALLOWED_MODELS_URLS");
    expect(src).toContain("assertSafeFetchUrl");
    expect(src).toContain("proxyAwareFetch");
    expect(src).not.toMatch(/\bfetch\s*\(/);
  });
});

describe("provider-nodes validate proxy migration", () => {
  it("route source uses proxyAwareFetch with abort-based timeout", () => {
    const src = readFileSync(
      join(root, "../../src/app/api/provider-nodes/validate/route.js"),
      "utf8"
    );
    expect(src).toContain("proxyAwareFetch");
    expect(src).toContain("AbortController");
    expect(src).not.toMatch(/\bfetch\s*\(/);
  });
});

describe("embeddings retry fail-closed", () => {
  it("returns error when post-refresh retry throws", () => {
    const src = readFileSync(
      join(root, "../../open-sse/handlers/embeddingsCore.js"),
      "utf8"
    );
    expect(src).toContain("retry after refresh failed");
    expect(src).toMatch(/catch \(retryError\)[\s\S]*return createErrorResult/);
  });
});

describe("image generation binary output fail-closed", () => {
  it("returns error when binaryOutput requested but no image data", () => {
    const src = readFileSync(
      join(root, "../../open-sse/handlers/imageGenerationCore.js"),
      "utf8"
    );
    expect(src).toContain("Binary output requested but no image data in response");
  });
});

describe("web fetch malformed JSON fail-closed", () => {
  it("readJsonOrText surfaces parse errors", () => {
    const src = readFileSync(
      join(root, "../../open-sse/handlers/fetch/index.js"),
      "utf8"
    );
    expect(src).toContain("parseError");
    expect(src).not.toMatch(/catch \{ return \{ text: "" \}/);
  });
});

describe("test-models no longer treats HTTP 400 as success", () => {
  it("pingModel only accepts HTTP 200 with choices", () => {
    const src = readFileSync(
      join(root, "../../src/app/api/providers/[id]/test-models/route.js"),
      "utf8"
    );
    expect(src).not.toContain("res.status === 400");
    expect(src).toContain("parsed?.choices");
  });
});

describe("v1beta streaming terminal validation", () => {
  it("tracks terminal chunk and errors on truncated stream", () => {
    const src = readFileSync(
      join(root, "../../src/app/api/v1beta/models/[...path]/route.js"),
      "utf8"
    );
    expect(src).toContain("sawTerminal");
    expect(src).toContain("Stream ended without terminal completion chunk");
  });
});

describe("v1/audio/voices internal origin", () => {
  it("uses internalApiGet with path-based provider map (no request origin SSRF)", () => {
    const src = readFileSync(
      join(root, "../../src/app/api/v1/audio/voices/route.js"),
      "utf8"
    );
    expect(src).toContain("internalApiGet");
    expect(src).toContain('elevenlabs: "/api/media-providers/tts/elevenlabs/voices"');
    expect(src).not.toMatch(/PROVIDER_API\[provider\]\(origin\)/);
    expect(src).not.toMatch(/\bfetch\s*\(/);
  });
});

describe("kilo free-models proxy migration", () => {
  it("uses proxyAwareFetch for Kilo models API", () => {
    const src = readFileSync(
      join(root, "../../src/app/api/providers/kilo/free-models/route.js"),
      "utf8"
    );
    expect(src).toContain("proxyAwareFetch");
    expect(src).not.toMatch(/\bfetch\s*\(/);
  });
});
