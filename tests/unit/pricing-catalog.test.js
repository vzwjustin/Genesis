import { describe, it, expect, beforeEach } from "vitest";
import {
  buildDefaultPricingCatalog,
  getDefaultPricing,
  getPricingForModel,
  MODEL_PRICING,
} from "../../src/shared/constants/pricing.js";

describe("pricing catalog", () => {
  it("buildDefaultPricingCatalog includes canonical models and provider overrides", () => {
    const catalog = buildDefaultPricingCatalog();
    expect(catalog.models["claude-sonnet-4-6"]).toBeDefined();
    expect(catalog.models["gpt-4o"]).toBeDefined();
    expect(Object.keys(catalog.models).length).toBe(Object.keys(MODEL_PRICING).length);
    expect(catalog.gh?.["gpt-5.3-codex"]).toBeDefined();
  });

  it("getDefaultPricing matches full catalog", () => {
    expect(getDefaultPricing()).toEqual(buildDefaultPricingCatalog());
  });

  it("resolves provider override by provider id or alias", () => {
    const byAlias = getPricingForModel("gh", "gpt-5.3-codex");
    const byId = getPricingForModel("github", "gpt-5.3-codex");
    expect(byAlias).toEqual(byId);
    expect(byAlias.input).toBe(1.75);
  });

  it("falls back to pattern pricing for unknown codex variants", () => {
    const pricing = getPricingForModel("codex", "gpt-5.3-codex-spark");
    expect(pricing).toBeTruthy();
    expect(pricing.input).toBe(3.0);
  });
});

describe("pricingRepo catalog merge", () => {
  beforeEach(async () => {
    const { resetAllPricing } = await import("../../src/lib/db/repos/pricingRepo.js");
    await resetAllPricing();
  });

  it("getPricing returns full canonical catalog", async () => {
    const { getPricing } = await import("../../src/lib/db/repos/pricingRepo.js");
    const pricing = await getPricing();
    expect(pricing.models?.["claude-opus-4-6"]).toBeDefined();
    expect(Object.keys(pricing.models).length).toBeGreaterThan(50);
  });

  it("getPricingForModel honors user overrides in models bucket", async () => {
    const { updatePricing, getPricingForModel } = await import("../../src/lib/db/repos/pricingRepo.js");
    await updatePricing({
      models: {
        "brand-new-model": { input: 9, output: 18, cached: 1, reasoning: 18, cache_creation: 9 },
      },
    });
    const pricing = await getPricingForModel("openrouter", "brand-new-model");
    expect(pricing).toEqual({
      input: 9,
      output: 18,
      cached: 1,
      reasoning: 18,
      cache_creation: 9,
    });
  });
});
