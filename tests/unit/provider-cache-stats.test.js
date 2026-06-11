import { describe, it, expect, vi, beforeEach } from "vitest";
import { normalizeCacheTokens } from "../../src/lib/cacheTokenUtils.js";

const mocks = vi.hoisted(() => ({
  rows: [],
}));

vi.mock("../../src/lib/db/driver.js", () => ({
  getAdapter: vi.fn(async () => ({
    all: vi.fn(() => mocks.rows),
  })),
}));

describe("getProviderCacheStats", () => {
  beforeEach(() => {
    mocks.rows = [];
  });

  it("normalizeCacheTokens reads anthropic and openai cache fields", () => {
    expect(normalizeCacheTokens({
      prompt_tokens: 1000,
      cache_read_input_tokens: 400,
      cache_creation_input_tokens: 50,
    })).toMatchObject({
      input: 1000,
      output: 0,
      cacheRead: 400,
      cacheCreate: 50,
      hasCache: true,
      hasCacheTelemetry: true,
    });

    expect(normalizeCacheTokens({
      prompt_tokens: 500,
      completion_tokens: 20,
      cached_tokens: 300,
    }).cacheRead).toBe(300);
  });

  it("aggregates cache tokens from usage history rows", async () => {
    mocks.rows = [
      {
        timestamp: "2026-06-08T10:00:00.000Z",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        tokens: JSON.stringify({
          prompt_tokens: 1000,
          completion_tokens: 100,
          cache_read_input_tokens: 800,
        }),
      },
      {
        timestamp: "2026-06-08T10:01:00.000Z",
        provider: "openai",
        model: "gpt-4o",
        tokens: JSON.stringify({
          prompt_tokens: 200,
          completion_tokens: 50,
          cached_tokens: 120,
        }),
      },
    ];

    const { getProviderCacheStats } = await import("../../src/lib/db/repos/usageRepo.js");
    const stats = await getProviderCacheStats("7d");

    expect(stats.requests).toBe(2);
    expect(stats.requestsWithTelemetry).toBe(2);
    expect(stats.cacheReadTokens).toBe(920);
    expect(stats.hitRate).toBe(43.4);
    expect(stats.byProvider).toHaveLength(2);
  });

  it("dedupes duplicate logs and keeps the row with cache telemetry", async () => {
    mocks.rows = [
      {
        timestamp: "2026-06-08T10:00:00.000Z",
        provider: "claude",
        model: "claude-opus-4-8",
        tokens: JSON.stringify({ prompt_tokens: 2, completion_tokens: 100 }),
      },
      {
        timestamp: "2026-06-08T10:00:00.500Z",
        provider: "claude",
        model: "claude-opus-4-8",
        tokens: JSON.stringify({
          prompt_tokens: 2,
          completion_tokens: 100,
          cache_read_input_tokens: 50_000,
          cache_creation_input_tokens: 200,
        }),
      },
    ];

    const { getProviderCacheStats } = await import("../../src/lib/db/repos/usageRepo.js");
    const stats = await getProviderCacheStats("7d");

    expect(stats.requests).toBe(1);
    expect(stats.requestsWithTelemetry).toBe(1);
    expect(stats.cacheReadTokens).toBe(50_000);
    expect(stats.hitRate).toBeGreaterThan(95);
  });
});
