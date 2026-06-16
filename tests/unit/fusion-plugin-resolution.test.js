import { describe, it, expect } from "vitest";
import { resolveFusionPlugins } from "../../open-sse/utils/fusionPlugin.js";

describe("resolveFusionPlugins", () => {
  it("returns Quality preset when no saved config", () => {
    const plugins = resolveFusionPlugins({ alias: "fusion", model: "fusion" });
    expect(plugins?.[0]?.id).toBe("fusion");
    expect(plugins[0].analysis_models).toEqual([
      "~anthropic/claude-opus-latest",
      "~openai/gpt-latest",
      "~google/gemini-pro-latest",
    ]);
    expect(plugins[0].model).toBe("~anthropic/claude-opus-latest");
  });

  it("returns Budget preset for fusion-budget", () => {
    const plugins = resolveFusionPlugins({ alias: "fusion", model: "fusion-budget" });
    expect(plugins[0].analysis_models).toEqual([
      "~google/gemini-flash-latest",
      "deepseek/deepseek-v3.2",
      "~moonshotai/kimi-latest",
    ]);
    expect(plugins[0].model).toBe("~google/gemini-flash-latest");
  });

  it("merges saved overrides onto catalog preset instead of bare plugin id", () => {
    const plugins = resolveFusionPlugins({
      alias: "fusion",
      model: "fusion",
      savedFusion: { enabled: true },
    });
    expect(plugins[0].analysis_models?.length).toBeGreaterThan(0);
    expect(plugins[0].model).toBe("~anthropic/claude-opus-latest");
  });

  it("applies custom panel and judge from saved config", () => {
    const plugins = resolveFusionPlugins({
      alias: "fusion",
      model: "fusion",
      savedFusion: {
        enabled: true,
        analysis_models: ["anthropic/claude-sonnet-4", "openai/gpt-4o"],
        model: "anthropic/claude-opus-4",
        max_tool_calls: 12,
      },
    });
    expect(plugins[0].analysis_models).toEqual([
      "anthropic/claude-sonnet-4",
      "openai/gpt-4o",
    ]);
    expect(plugins[0].model).toBe("anthropic/claude-opus-4");
    expect(plugins[0].max_tool_calls).toBe(12);
  });

  it("accepts camelCase saved fields", () => {
    const plugins = resolveFusionPlugins({
      alias: "fusion",
      model: "fusion",
      savedFusion: {
        enabled: true,
        analysisModels: ["openai/gpt-4o-mini"],
        maxToolCalls: 5,
      },
    });
    expect(plugins[0].analysis_models).toEqual(["openai/gpt-4o-mini"]);
    expect(plugins[0].max_tool_calls).toBe(5);
  });

  it("resolves Quality preset when model id is upstream openrouter/fusion", () => {
    const plugins = resolveFusionPlugins({
      alias: "fusion",
      model: "openrouter/fusion",
      savedFusion: { enabled: true },
    });
    expect(plugins[0].analysis_models?.length).toBeGreaterThan(0);
    expect(plugins[0].model).toBe("~anthropic/claude-opus-latest");
  });

  it("returns undefined when deliberation is explicitly disabled", () => {
    expect(
      resolveFusionPlugins({
        alias: "fusion",
        model: "fusion",
        savedFusion: { enabled: false },
      })
    ).toBeUndefined();
  });
});
