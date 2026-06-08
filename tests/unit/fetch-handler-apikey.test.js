/**
 * handleFetch apiKey scope — combo path must pass auth apiKey into single-provider handler.
 * No mocks: source inspection.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const root = dirname(fileURLToPath(import.meta.url));

describe("handleFetch apiKey scope", () => {
  it("combo path passes apiKey into handleSingleProviderFetch", () => {
    const src = readFileSync(join(root, "../../src/sse/handlers/fetch.js"), "utf8");
    expect(src).toContain("const { apiKey, settings } = auth");
    expect(src).toContain("handleSingleProviderFetch(b, m, request, apiKey, settings)");
    expect(src).toContain("handleComboChat");
  });

  it("single-provider path receives apiKey parameter", () => {
    const src = readFileSync(join(root, "../../src/sse/handlers/fetch.js"), "utf8");
    expect(src).toMatch(/handleSingleProviderFetch\([^)]*apiKey/);
    expect(src).toContain("resolveProviderRetryLimits");
    expect(src).toContain("noActiveCredentialsResponse");
  });
});
