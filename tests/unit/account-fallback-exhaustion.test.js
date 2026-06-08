/**
 * Account fallback exhaustion (Tasks 6.5–6.7)
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

const HANDLER_FILES = [
  "../../src/sse/handlers/chat.js",
  "../../src/sse/handlers/embeddings.js",
  "../../src/sse/handlers/search.js",
  "../../src/sse/handlers/fetch.js",
  "../../src/sse/handlers/imageGeneration.js",
];

function readHandler(relPath) {
  return readFileSync(join(root, relPath), "utf8");
}

describe("noActiveCredentialsResponse (Req 4.8)", () => {
  it("returns HTTP 404 with provider name in message", async () => {
    const response = noActiveCredentialsResponse("claude");
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.message).toBe("No active credentials for provider: claude");
  });
});

describe("exhaustedAccountsResponse (Req 4.5, 4.7)", () => {
  it("returns Retry-After >= 1 when all accounts exhausted", () => {
    const response = exhaustedAccountsResponse(true, 503, "All accounts unavailable");
    const retryAfter = parseInt(response.headers.get("Retry-After"), 10);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
  });

  it("forces HTTP 503 when had5xx is true even if last status was 429", async () => {
    const response = exhaustedAccountsResponse(true, 429, "rate limited");
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.message).toContain("rate limited");
  });

  it("preserves last non-5xx status when no 5xx occurred", async () => {
    const response = exhaustedAccountsResponse(false, 429, "rate limited");
    expect(response.status).toBe(429);
  });
});

describe("handler retry wiring (source)", () => {
  for (const rel of HANDLER_FILES) {
    const name = rel.split("/").pop();
    it(`${name} uses resolveProviderRetryLimits and zero-connection guard`, () => {
      const src = readHandler(rel);
      expect(src).toContain("resolveProviderRetryLimits");
      expect(src).toContain("noActiveCredentialsResponse");
      expect(src).toContain("exhaustedAccountsResponse");
      expect(src).toMatch(/maxRetries\s*===\s*0/);
      expect(src).toMatch(/retryCount\s*>=\s*maxRetries/);
    });
  }

  it("chat.js tracks had5xx for exhaustion status (Req 4.5)", () => {
    const src = readHandler("../../src/sse/handlers/chat.js");
    expect(src).toContain("had5xx");
  });

  it("FREE_PROVIDERS noAuth bypasses zero-connection 404 (source)", () => {
    const src = readHandler("../../src/sse/handlers/chat.js");
    expect(src).toContain("isNoAuthProvider");
    expect(src).toMatch(/!isNoAuthProvider\s*&&\s*maxRetries\s*===\s*0/);
  });
});

describe("providerCredentialRetry module (source)", () => {
  it("maxRetries equals connection count for auth providers", () => {
    const src = readFileSync(join(root, "../../src/sse/utils/providerCredentialRetry.js"), "utf8");
    expect(src).toContain("allConnections.length");
    expect(src).toContain("FREE_PROVIDERS");
    expect(src).toContain("isNoAuthProvider ? 1");
  });
});
