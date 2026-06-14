import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openaiToClaudeRequest } from "../../open-sse/translator/request/openai-to-claude.js";
import { isUnrecoverableRefreshError } from "../../open-sse/services/tokenRefresh.js";

const root = dirname(fileURLToPath(import.meta.url));

describe("wave3 — reasoning_effort none", () => {
  it("openai-to-claude maps reasoning_effort none to thinking disabled", () => {
    const out = openaiToClaudeRequest("claude-sonnet-4-20250514", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "none",
    });
    expect(out.thinking).toEqual({ type: "disabled" });
  });

  it("chatCore normalizes reasoning_effort none before translation", () => {
    const src = readFileSync(join(root, "../../open-sse/handlers/chatCore.js"), "utf8");
    expect(src).toMatch(/reasoning_effort === "none"/);
    expect(src).toMatch(/thinking: \{ type: "disabled" \}/);
  });
});

describe("wave3 — unrecoverable refresh distinction", () => {
  it("isUnrecoverableRefreshError detects unrecoverable_refresh_error object", () => {
    expect(isUnrecoverableRefreshError({ error: "unrecoverable_refresh_error" })).toBe(true);
    expect(isUnrecoverableRefreshError(null)).toBeFalsy();
    expect(isUnrecoverableRefreshError({ accessToken: "x" })).toBeFalsy();
  });

  it("chatCore, embeddingsCore, imageGenerationCore branch on isUnrecoverableRefreshError", () => {
    for (const file of ["chatCore.js", "embeddingsCore.js", "imageGenerationCore.js"]) {
      const src = readFileSync(join(root, `../../open-sse/handlers/${file}`), "utf8");
      expect(src).toContain("isUnrecoverableRefreshError");
      expect(src).toContain("unrecoverable refresh");
    }
  });
});

describe("wave3 — embeddings/image AbortSignal", () => {
  it("embeddingsCore accepts signal and passes to proxyAwareFetch", () => {
    const src = readFileSync(join(root, "../../open-sse/handlers/embeddingsCore.js"), "utf8");
    expect(src).toMatch(/signal\?\.aborted/);
    expect(src).toContain("signal,");
    expect(src).toContain("Request aborted");
  });

  it("imageGenerationCore accepts signal and passes to proxyAwareFetch", () => {
    const src = readFileSync(join(root, "../../open-sse/handlers/imageGenerationCore.js"), "utf8");
    expect(src).toMatch(/signal\?\.aborted/);
    expect(src).toContain("signal,");
  });

  it("SSE handlers pass request.signal into core handlers", () => {
    const emb = readFileSync(join(root, "../../src/sse/handlers/embeddings.js"), "utf8");
    const img = readFileSync(join(root, "../../src/sse/handlers/imageGeneration.js"), "utf8");
    expect(emb).toContain("request.signal");
    expect(img).toContain("request.signal");
  });

  it("handleEmbeddingsCore returns 499 when signal already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const { handleEmbeddingsCore } = await import("../../open-sse/handlers/embeddingsCore.js");
    const result = await handleEmbeddingsCore({
      body: { input: "hello" },
      modelInfo: { provider: "openai", model: "text-embedding-3-small" },
      credentials: {},
      signal: ac.signal,
    });
    expect(result.success).toBe(false);
    expect(result.status).toBe(499);
  });
});
