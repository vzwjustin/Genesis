/**
 * Round 15 — provider validate + test harness proxy migration
 * No mocks: source inspection.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const root = dirname(fileURLToPath(import.meta.url));
const apiProvidersRoot = join(root, "../../src/app/api/providers");

describe("provider validate route proxy migration", () => {
  it("uses proxyAwareFetch with connection proxy during API key validation", () => {
    const src = readFileSync(join(apiProvidersRoot, "validate/route.js"), "utf8");
    expect(src).toContain("validateFetch");
    expect(src).toContain("proxyAwareFetch");
    expect(src).toContain("resolveConnectionProxyConfig");
    expect(src).not.toMatch(/\bfetch\s*\(/);
  });
});

describe("provider test harness bare fetch audit", () => {
  it("validate route and testUtils do not use bare fetch()", () => {
    const validateSrc = readFileSync(join(apiProvidersRoot, "validate/route.js"), "utf8");
    const testUtilsSrc = readFileSync(join(apiProvidersRoot, "[id]/test/testUtils.js"), "utf8");
    expect(validateSrc).toContain("validateFetch");
    expect(validateSrc).toContain("proxyAwareFetch");
    expect(validateSrc).not.toMatch(/\bfetch\s*\(/);
    expect(testUtilsSrc).toContain("fetchWithConnectionProxy");
    expect(testUtilsSrc).not.toMatch(/\bfetch\s*\(/);
  });
});
