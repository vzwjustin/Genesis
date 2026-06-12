import { describe, it, expect } from "vitest";
import {
  swapConnectionPriorityUpdates,
  pickHighestPriorityActiveConnection,
  diffPricingOverrides,
  isAbortError,
  isImportModelsAuthFailure,
} from "../../src/shared/utils/dashboardHelpers.js";
import { getDefaultPricing } from "../../src/shared/constants/pricing.js";

describe("swapConnectionPriorityUpdates", () => {
  it("swaps stored priority values between connections", () => {
    const conn1 = { id: "a", priority: 1 };
    const conn2 = { id: "b", priority: 5 };
    expect(swapConnectionPriorityUpdates(conn1, conn2)).toEqual([
      { connectionId: "a", priority: 5 },
      { connectionId: "b", priority: 1 },
    ]);
  });

  it("treats null priority as 999 when swapping", () => {
    const conn1 = { id: "a", priority: null };
    const conn2 = { id: "b", priority: 2 };
    expect(swapConnectionPriorityUpdates(conn1, conn2)).toEqual([
      { connectionId: "a", priority: 2 },
      { connectionId: "b", priority: 999 },
    ]);
  });

  it("does not use array indices as priorities", () => {
    const conn1 = { id: "a", priority: 10 };
    const conn2 = { id: "b", priority: 20 };
    const updates = swapConnectionPriorityUpdates(conn1, conn2);
    expect(updates.map((u) => u.priority)).toEqual([20, 10]);
    expect(updates.map((u) => u.priority)).not.toEqual([0, 1]);
  });
});

describe("pickHighestPriorityActiveConnection", () => {
  it("prefers lowest priority number among active connections", () => {
    const connections = [
      { id: "low", priority: 2, isActive: true },
      { id: "high", priority: 1, isActive: true },
      { id: "inactive", priority: 0, isActive: false },
    ];
    expect(pickHighestPriorityActiveConnection(connections)?.id).toBe("high");
  });

  it("returns null when no active connections", () => {
    expect(pickHighestPriorityActiveConnection([{ id: "x", isActive: false }])).toBeNull();
  });
});

describe("diffPricingOverrides", () => {
  it("returns only models that differ from defaults", () => {
    const defaults = getDefaultPricing();
    const current = structuredClone(defaults);
    current.models["gpt-4o"].input = 99;

    const overrides = diffPricingOverrides(current, defaults);
    expect(Object.keys(overrides)).toEqual(["models"]);
    expect(overrides.models["gpt-4o"].input).toBe(99);
    expect(Object.keys(overrides.models)).toEqual(["gpt-4o"]);
  });

  it("returns empty object when nothing changed", () => {
    const defaults = getDefaultPricing();
    expect(diffPricingOverrides(defaults, defaults)).toEqual({});
  });

  it("emits per-field null tombstones when individual fields revert to default", () => {
    const defaults = getDefaultPricing();
    const current = structuredClone(defaults);
    current.models["gpt-4o"].input = defaults.models["gpt-4o"].input;
    current.models["gpt-4o"].output = 77;
    const existingOverrides = {
      models: {
        "gpt-4o": { input: 99, output: 18 },
      },
    };

    const overrides = diffPricingOverrides(current, defaults, existingOverrides);
    expect(overrides.models["gpt-4o"]).toEqual({ input: null, output: 77 });
  });

  it("emits null tombstone when user reverts an existing override to default", () => {
    const defaults = getDefaultPricing();
    const current = structuredClone(defaults);
    const existingOverrides = {
      models: {
        "gpt-4o": { input: 99 },
      },
    };

    const overrides = diffPricingOverrides(current, defaults, existingOverrides);
    expect(overrides.models["gpt-4o"]).toBeNull();
  });

  it("does not tombstone models that were never overridden", () => {
    const defaults = getDefaultPricing();
    const overrides = diffPricingOverrides(defaults, defaults, {});
    expect(overrides).toEqual({});
  });
});

describe("isAbortError", () => {
  it("detects AbortError", () => {
    expect(isAbortError({ name: "AbortError" })).toBe(true);
    expect(isAbortError(new DOMException("aborted", "AbortError"))).toBe(true);
    expect(isAbortError(new Error("network"))).toBe(false);
  });
});

describe("isImportModelsAuthFailure", () => {
  it("flags auth failures only", () => {
    expect(isImportModelsAuthFailure({ authFailure: true })).toBe(true);
    expect(isImportModelsAuthFailure({ upstreamFailure: true })).toBe(false);
    expect(isImportModelsAuthFailure({ warning: "Session expired; reconnect" })).toBe(true);
    expect(isImportModelsAuthFailure({ warning: "Falling back to cached models" })).toBe(false);
    expect(isImportModelsAuthFailure({ imported: 2, total: 2 })).toBe(false);
    expect(isImportModelsAuthFailure({ status: "degraded", warning: "upstream timeout" })).toBe(false);
    expect(isImportModelsAuthFailure({ warning: "upstream token bucket limit" })).toBe(false);
    expect(isImportModelsAuthFailure({ warning: "invalid token for provider" })).toBe(true);
  });
});
