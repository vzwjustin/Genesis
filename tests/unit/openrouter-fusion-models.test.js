import { describe, it, expect } from "vitest";
import {
  getModelUpstreamId,
  getModelRequestExtras,
} from "../../open-sse/config/providerModels.js";

describe("openrouter-fusion model routing", () => {
  it("maps fusion to upstream openrouter/fusion", () => {
    expect(getModelUpstreamId("openrouter-fusion", "fusion")).toBe("openrouter/fusion");
    expect(getModelUpstreamId("openrouter-fusion", "fusion-budget")).toBe("openrouter/fusion");
  });

  it("injects Quality preset plugins for fusion", () => {
    const extras = getModelRequestExtras("openrouter-fusion", "fusion");
    expect(extras?.plugins?.[0]?.id).toBe("fusion");
    expect(extras.plugins[0].analysis_models).toEqual([
      "~anthropic/claude-opus-latest",
      "~openai/gpt-latest",
      "~google/gemini-pro-latest",
    ]);
    expect(extras.plugins[0].model).toBe("~anthropic/claude-opus-latest");
  });

  it("injects Budget preset plugins for fusion-budget", () => {
    const extras = getModelRequestExtras("openrouter-fusion", "fusion-budget");
    expect(extras?.plugins?.[0]?.id).toBe("fusion");
    expect(extras.plugins[0].analysis_models).toEqual([
      "~google/gemini-flash-latest",
      "deepseek/deepseek-v3.2",
      "~moonshotai/kimi-latest",
    ]);
    expect(extras.plugins[0].model).toBe("~google/gemini-flash-latest");
  });
});
