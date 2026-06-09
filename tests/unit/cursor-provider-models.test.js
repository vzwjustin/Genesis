import { describe, it, expect } from "vitest";
import { PROVIDER_MODELS } from "../../open-sse/config/providerModels.js";

describe("Cursor (cu) provider models", () => {
  const cu = PROVIDER_MODELS.cu;
  const ids = new Set(cu.map((m) => m.id));

  it("includes Composer 2.5 variants", () => {
    expect(ids.has("composer-2.5")).toBe(true);
    expect(ids.has("composer-2.5-fast")).toBe(true);
  });

  it("includes current frontier models from Cursor agent CLI", () => {
    expect(ids.has("auto")).toBe(true);
    expect(ids.has("claude-opus-4-8-high")).toBe(true);
    expect(ids.has("gpt-5.5-medium")).toBe(true);
    expect(ids.has("gpt-5.4-medium")).toBe(true);
  });

  it("maps legacy default id to auto upstream", () => {
    const legacy = cu.find((m) => m.id === "default");
    expect(legacy?.upstreamModelId).toBe("auto");
  });

  it("lists Composer 2.5 near the top for discoverability", () => {
    const composerFastIdx = cu.findIndex((m) => m.id === "composer-2.5-fast");
    const opusIdx = cu.findIndex((m) => m.id === "claude-opus-4-8-high");
    expect(composerFastIdx).toBeGreaterThanOrEqual(0);
    expect(composerFastIdx).toBeLessThan(opusIdx);
  });
});
