import { describe, it, expect } from "vitest";
import { normalizeCacheTokens, computeTokenWeightedCacheHitRate } from "../../src/lib/cacheTokenUtils.js";

describe("computeTokenWeightedCacheHitRate", () => {
  it("returns cache_read share of prompt-side tokens", () => {
    expect(computeTokenWeightedCacheHitRate({
      cacheRead: 150_000,
      input: 2,
      cacheCreate: 1_000,
    })).toBe(99.3);
  });

  it("returns 0 when no prompt-side tokens", () => {
    expect(computeTokenWeightedCacheHitRate({ cacheRead: 0, input: 0, cacheCreate: 0 })).toBe(0);
  });
});

describe("normalizeCacheTokens telemetry", () => {
  it("flags rows with provider cache fields", () => {
    expect(normalizeCacheTokens({
      prompt_tokens: 2,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 0,
    }).hasCacheTelemetry).toBe(true);
  });

  it("excludes estimated usage from telemetry", () => {
    expect(normalizeCacheTokens({
      prompt_tokens: 500,
      completion_tokens: 100,
      estimated: true,
    }).hasCacheTelemetry).toBe(false);
  });

  it("excludes legacy rows missing cache fields", () => {
    expect(normalizeCacheTokens({
      prompt_tokens: 131,
      completion_tokens: 1628,
    }).hasCacheTelemetry).toBe(false);
  });
});
