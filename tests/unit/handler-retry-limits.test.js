/**
 * Max retry limits for non-chat handlers (embeddings, search).
 * No mocks: providerCredentialRetry helpers + handler source inspection.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  noActiveCredentialsResponse,
  exhaustedAccountsResponse,
} from "../../src/sse/utils/providerCredentialRetry.js";

const root = dirname(fileURLToPath(import.meta.url));

describe("embeddings handler — retry limits (source)", () => {
  it("uses resolveProviderRetryLimits and returns 404 when maxRetries is zero", () => {
    const src = readFileSync(join(root, "../../src/sse/handlers/embeddings.js"), "utf8");
    expect(src).toContain("resolveProviderRetryLimits");
    expect(src).toContain("noActiveCredentialsResponse");
    expect(src).toMatch(/maxRetries\s*===\s*0/);
    expect(src).toMatch(/retryCount\s*>=\s*maxRetries/);
    expect(src).toContain("handleEmbeddingsCore");
  });

  it("increments retryCount after token refresh pre-check", () => {
    const src = readFileSync(join(root, "../../src/sse/handlers/embeddings.js"), "utf8");
    const loop = src.slice(src.indexOf("while (true)"));
    const tokenRefreshIdx = loop.indexOf("_tokenRefreshFailed");
    const retryIncIdx = loop.indexOf("retryCount++");
    expect(retryIncIdx).toBeGreaterThan(tokenRefreshIdx);
  });

  it("noActiveCredentialsResponse returns 404 for embeddings path", async () => {
    const response = noActiveCredentialsResponse("openai");
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.message).toBe("No active credentials for provider: openai");
  });
});

describe("search handler — retry limits (source)", () => {
  it("uses resolveProviderRetryLimits in handleSingleProviderSearch", () => {
    const src = readFileSync(join(root, "../../src/sse/handlers/search.js"), "utf8");
    expect(src).toContain("resolveProviderRetryLimits");
    expect(src).toContain("exhaustedAccountsResponse");
    expect(src).toMatch(/retryCount\s*>=\s*maxRetries/);
    expect(src).toContain("handleSearchCore");
  });

  it("increments retryCount after token refresh pre-check", () => {
    const src = readFileSync(join(root, "../../src/sse/handlers/search.js"), "utf8");
    const loop = src.slice(src.indexOf("while (true)"));
    const tokenRefreshIdx = loop.indexOf("_tokenRefreshFailed");
    const retryIncIdx = loop.indexOf("retryCount++");
    expect(retryIncIdx).toBeGreaterThan(tokenRefreshIdx);
  });

  it("no-auth searxng bypasses credential retry loop", () => {
    const src = readFileSync(join(root, "../../src/sse/handlers/search.js"), "utf8");
    expect(src).toContain("resolvedProvider.noAuth");
    expect(src).toContain("handleSearchCore");
  });

  it("exhaustedAccountsResponse includes minimum Retry-After", () => {
    const response = exhaustedAccountsResponse(false, 503, "upstream down");
    expect(parseInt(response.headers.get("Retry-After"), 10)).toBeGreaterThanOrEqual(1);
  });
});
