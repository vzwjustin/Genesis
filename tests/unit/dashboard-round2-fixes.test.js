import { describe, it, expect, beforeEach } from "vitest";

describe("connectionsRepo round-2 fixes", () => {
  beforeEach(async () => {
    const { getAdapter } = await import("../../src/lib/db/driver.js");
    const db = await getAdapter();
    db.run(`DELETE FROM providerConnections`);
  });

  it("reorderInTx treats null priority like getProviderConnections (999)", async () => {
    const {
      createProviderConnection,
      getProviderConnections,
      swapProviderConnectionPriorities,
    } = await import("../../src/lib/db/repos/connectionsRepo.js");

    const provider = `priority-null-${Date.now()}`;
    const a = await createProviderConnection({
      provider,
      authType: "apikey",
      name: "A",
      priority: 1,
      apiKey: "key-a",
    });
    const b = await createProviderConnection({
      provider,
      authType: "apikey",
      name: "B",
      priority: null,
      apiKey: "key-b",
    });
    const c = await createProviderConnection({
      provider,
      authType: "apikey",
      name: "C",
      priority: 2,
      apiKey: "key-c",
    });

    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(c).toBeTruthy();

    const { getAdapter } = await import("../../src/lib/db/driver.js");
    const db = await getAdapter();
    db.run(`UPDATE providerConnections SET priority = NULL WHERE id = ?`, [b.id]);

    const before = await getProviderConnections({ provider });
    expect(before.map((conn) => conn.name)).toEqual(["A", "C", "B"]);

    const swapped = await swapProviderConnectionPriorities(a.id, b.id);
    expect(swapped).toBe(true);

    const after = await getProviderConnections({ provider });
    expect(after[0].id).toBe(b.id);
  });
});

describe("pricingRepo tombstone clears", () => {
  beforeEach(async () => {
    const { resetAllPricing } = await import("../../src/lib/db/repos/pricingRepo.js");
    await resetAllPricing();
  });

  it("updatePricing removes model override on null tombstone", async () => {
    const { updatePricing, getUserPricingOverrides, getPricingForModel } = await import(
      "../../src/lib/db/repos/pricingRepo.js"
    );

    await updatePricing({
      models: {
        "gpt-4o": { input: 99, output: 18, cached: 1, reasoning: 18, cache_creation: 9 },
      },
    });

    expect((await getUserPricingOverrides()).models?.["gpt-4o"]?.input).toBe(99);

    await updatePricing({ models: { "gpt-4o": null } });

    expect((await getUserPricingOverrides()).models?.["gpt-4o"]).toBeUndefined();
    const resolved = await getPricingForModel("openai", "gpt-4o");
    expect(resolved.input).not.toBe(99);
  });
});

describe("settingsRepo per-provider strategy merge", () => {
  beforeEach(async () => {
    const { updateSettings } = await import("../../src/lib/db/repos/settingsRepo.js");
    await updateSettings({
      providerStrategies: {
        openai: { fallbackStrategy: "round-robin", stickyRoundRobinLimit: 2 },
        anthropic: { fallbackStrategy: "round-robin", stickyRoundRobinLimit: 5 },
      },
    });
  });

  it("patches one provider without wiping others", async () => {
    const { updateSettings, getSettings } = await import("../../src/lib/db/repos/settingsRepo.js");

    await updateSettings({
      providerStrategies: {
        openai: { fallbackStrategy: "round-robin", stickyRoundRobinLimit: 3 },
      },
    });

    const settings = await getSettings();
    expect(settings.providerStrategies.openai.stickyRoundRobinLimit).toBe(3);
    expect(settings.providerStrategies.anthropic.stickyRoundRobinLimit).toBe(5);
  });

  it("removes one provider override with null tombstone", async () => {
    const { updateSettings, getSettings } = await import("../../src/lib/db/repos/settingsRepo.js");

    await updateSettings({ providerStrategies: { openai: null } });

    const settings = await getSettings();
    expect(settings.providerStrategies.openai).toBeUndefined();
    expect(settings.providerStrategies.anthropic.stickyRoundRobinLimit).toBe(5);
  });
});
