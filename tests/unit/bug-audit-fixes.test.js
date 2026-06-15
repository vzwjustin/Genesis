/**
 * Regression tests for bug-audit remediations.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("usageRepo — API key storage refs", () => {
  it("saveRequestUsage stores opaque key ref, not plaintext", async () => {
    const runs = [];
    const mockDb = {
      transaction(fn) { return fn(); },
      run(sql, params) {
        runs.push({ sql, params });
        return { changes: 1 };
      },
      get() { return null; },
    };

    vi.doMock("../../src/lib/db/repos/apiKeysRepo.js", () => ({
      getApiKeys: async () => [{ id: "kid-1", key: "sk-test-secret", name: "demo" }],
    }));
    vi.doMock("../../src/lib/db/repos/connectionsRepo.js", () => ({
      getProviderConnections: async () => [],
    }));
    vi.doMock("../../src/lib/db/repos/pricingRepo.js", () => ({
      getPricingForModel: async () => null,
    }));
    vi.doMock("../../src/lib/db/repos/nodesRepo.js", () => ({
      getProviderNodes: async () => [],
    }));
    vi.doMock("../../src/lib/db/driver.js", () => ({
      getAdapter: async () => mockDb,
    }));

    const { saveRequestUsage } = await import("../../src/lib/db/repos/usageRepo.js");
    await saveRequestUsage({
      provider: "openai",
      model: "gpt-4",
      apiKey: "sk-test-secret",
      tokens: { prompt_tokens: 1, completion_tokens: 2 },
    });

    const historyInsert = runs.find((r) => r.sql.includes("INSERT OR IGNORE INTO usageHistory"));
    expect(historyInsert).toBeTruthy();
    expect(historyInsert.params[4]).toBe("key:kid-1");
    expect(JSON.stringify(historyInsert.params)).not.toContain("sk-test-secret");

    const dailyUpsert = runs.find((r) => r.sql.includes("usageDaily"));
    expect(dailyUpsert).toBeTruthy();
    expect(dailyUpsert.params[1]).not.toContain("sk-test-secret");
    expect(dailyUpsert.params[1]).toContain("key:kid-1");

    vi.resetModules();
  });
});

describe("usageRepo — per-request pending handles", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    global._pendingRequests = { byModel: {}, byAccount: {} };
    global._pendingTimers = {};
    global._nextPendingRequestId = 1;
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.values(global._pendingTimers || {}).forEach(clearTimeout);
    global._pendingTimers = {};
  });

  it("tracks concurrent same-model requests with independent timers", async () => {
    const { trackPendingRequest } = await import("../../src/lib/db/repos/usageRepo.js");

    const h1 = trackPendingRequest("gpt-4", "openai", "c1", true);
    const h2 = trackPendingRequest("gpt-4", "openai", "c1", true);
    expect(h1).not.toBe(h2);
    expect(global._pendingRequests.byModel["gpt-4 (openai)"]).toBe(2);

    trackPendingRequest("gpt-4", "openai", "c1", false, false, h1);
    expect(global._pendingRequests.byModel["gpt-4 (openai)"]).toBe(1);

    vi.advanceTimersByTime(60_000);
    expect(global._pendingRequests.byModel["gpt-4 (openai)"]).toBeUndefined();
  });
});
