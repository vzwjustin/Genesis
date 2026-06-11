import { describe, it, expect } from "vitest";
import { PROVIDER_MODELS } from "../../open-sse/config/providerModels.js";

describe("Kiro (kr) provider models", () => {
  const kr = PROVIDER_MODELS.kr;
  const ids = new Set(kr.map((m) => m.id));

  it("includes Claude Sonnet 4.6 base and synthetic variants", () => {
    expect(ids.has("claude-sonnet-4.6")).toBe(true);
    expect(ids.has("claude-sonnet-4.6-thinking")).toBe(true);
    expect(ids.has("claude-sonnet-4.6-agentic")).toBe(true);
    expect(ids.has("claude-sonnet-4.6-thinking-agentic")).toBe(true);
  });

  it("keeps Claude Sonnet 4.5 for backward compatibility", () => {
    expect(ids.has("claude-sonnet-4.5")).toBe(true);
  });

  it("lists Sonnet 4.6 before 4.5 for discoverability", () => {
    const idx46 = kr.findIndex((m) => m.id === "claude-sonnet-4.6");
    const idx45 = kr.findIndex((m) => m.id === "claude-sonnet-4.5");
    expect(idx46).toBeGreaterThanOrEqual(0);
    expect(idx46).toBeLessThan(idx45);
  });

  it("includes current non-Claude upstream models", () => {
    expect(ids.has("MiniMax-M2.5")).toBe(true);
    expect(ids.has("qwen3-coder-next")).toBe(true);
    expect(ids.has("glm-5")).toBe(true);
  });
});
