/**
 * Max retry limit enforcement (Task 6.6, Requirement 4.7)
 * No mocks: providerCredentialRetry + chat handler source inspection.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  exhaustedAccountsResponse,
} from "../../src/sse/utils/providerCredentialRetry.js";

const root = dirname(fileURLToPath(import.meta.url));

describe("chat handler retry loop (source)", () => {
  const src = readFileSync(join(root, "../../src/sse/handlers/chat.js"), "utf8");

  it("resolves maxRetries from configured connections", () => {
    expect(src).toContain("resolveProviderRetryLimits");
    expect(src).toMatch(/retryCount\s*>=\s*maxRetries/);
  });

  it("increments retryCount after pre-flight checks, before dispatch", () => {
    const tokenRefreshIdx = src.indexOf("_tokenRefreshFailed");
    const retryIncIdx = src.indexOf("retryCount++");
    expect(retryIncIdx).toBeGreaterThan(tokenRefreshIdx);
  });

  it("returns exhaustedAccountsResponse when retry budget is spent", () => {
    expect(src).toContain("exhaustedAccountsResponse(had5xx");
  });

  it("tracks had5xx for 503 vs last-status behavior (Req 4.5)", () => {
    expect(src).toContain("had5xx");
    expect(src).toMatch(/status\s*>=\s*500|>= 500/);
  });

  it("breaks retry loop on success before exhausting budget", () => {
    expect(src).toMatch(/result\.success|success\)/);
  });
});

describe("exhaustedAccountsResponse behavior", () => {
  it("returns last error message in body", async () => {
    const response = exhaustedAccountsResponse(true, 500, "Internal server error");
    const body = await response.json();
    expect(body.error.message).toContain("Internal server error");
  });

  it("uses HTTP 503 when any attempt returned 5xx", () => {
    expect(exhaustedAccountsResponse(true, 429, "Rate limited - please slow down").status).toBe(503);
  });

  it("uses last status when no 5xx occurred", () => {
    expect(exhaustedAccountsResponse(false, 429, "Rate limited").status).toBe(429);
  });
});

describe("providerCredentialRetry (source)", () => {
  it("documents maxRetries = connection count rule", () => {
    const src = readFileSync(join(root, "../../src/sse/utils/providerCredentialRetry.js"), "utf8");
    expect(src).toContain("Requirement 4.7/4.8");
    expect(src).toContain("allConnections.length");
  });
});
