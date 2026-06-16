import { describe, it, expect, vi, beforeEach } from "vitest";
import { normalizeCacheTokens } from "../../src/lib/cacheTokenUtils.js";

const mocks = vi.hoisted(() => ({
  rows: [],
  sinceArgs: [],
}));

vi.mock("../../src/lib/db/driver.js", () => ({
  getAdapter: vi.fn(async () => ({
    // Record the `timestamp >= since` cutoff each read uses. since is always params[0].
    all: vi.fn((_sql, params) => {
      const since = params?.[0];
      if (since) mocks.sinceArgs.push(since);
      return mocks.rows;
    }),
  })),
}));

describe("getProviderCacheStats", () => {
  beforeEach(() => {
    mocks.rows = [];
    mocks.sinceArgs = [];
    vi.useRealTimers();
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

  it("uses an identical window cutoff for refreshes within the same hour", async () => {
    // The "measured requests counts down on refresh" bug: an unquantized
    // now-cutoff slides the trailing edge forward every read, dropping the
    // oldest rows. Quantizing to the hour makes back-to-back reads idempotent.
    const { getProviderCacheStats } = await import("../../src/lib/db/repos/usageRepo.js");

    const base = Date.UTC(2026, 5, 8, 9, 0, 0); // on the hour
    vi.useFakeTimers();

    vi.setSystemTime(base + 2 * 60 * 1000);  // 09:02
    await getProviderCacheStats("7d");

    vi.setSystemTime(base + 57 * 60 * 1000); // 09:57, same hour, 55 min later
    await getProviderCacheStats("7d");

    expect(mocks.sinceArgs).toHaveLength(2);
    expect(mocks.sinceArgs[0]).toBe(mocks.sinceArgs[1]);

    vi.useRealTimers();
  });
});
