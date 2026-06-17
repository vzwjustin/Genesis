import { describe, it, expect } from "vitest";
import {
  normalizeKimiToolChoice,
  normalizeKimiInputSchema,
  normalizeKimiSamplingParams,
  ensureKimiThinkingEnabled,
  prepareKimiRequest,
  needsKimiCompatibility,
} from "../../open-sse/translator/helpers/kimiHelper.js";
import { prepareClaudeRequest } from "../../open-sse/translator/helpers/claudeHelper.js";

describe("kimi K2.7 compatibility", () => {
  it("detects kimi code models", () => {
    expect(needsKimiCompatibility("kimi-coding", "kimi-k2.7-code")).toBe(true);
    expect(needsKimiCompatibility("kimi", "kimi-k2.6")).toBe(true);
    expect(needsKimiCompatibility("claude", "kimi-k2.7-code")).toBe(false);
    expect(needsKimiCompatibility("kimi", "kimi-latest")).toBe(false);
  });

  it("normalizes tool_choice to auto/none only", () => {
    expect(normalizeKimiToolChoice({ type: "any" })).toEqual({ type: "auto" });
    expect(normalizeKimiToolChoice({ type: "tool", name: "Read" })).toEqual({ type: "auto" });
    expect(normalizeKimiToolChoice("required")).toEqual({ type: "auto" });
    expect(normalizeKimiToolChoice({ type: "none" })).toEqual({ type: "none" });
    expect(normalizeKimiToolChoice({ type: "auto" })).toEqual({ type: "auto" });
  });

  it("strips non-default sampling params", () => {
    const body = {
      temperature: 0.7,
      top_p: 0.8,
      presence_penalty: 0.5,
      top_k: 40,
      seed: 1,
    };
    normalizeKimiSamplingParams(body);
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
    expect(body.presence_penalty).toBeUndefined();
    expect(body.top_k).toBeUndefined();
    expect(body.seed).toBeUndefined();
  });

  it("keeps kimi-default sampling params", () => {
    const body = { temperature: 1.0, top_p: 0.95, n: 1 };
    normalizeKimiSamplingParams(body);
    expect(body.temperature).toBe(1.0);
    expect(body.top_p).toBe(0.95);
    expect(body.n).toBe(1);
  });

  it("adds required: [] to empty object tool schemas", () => {
    expect(normalizeKimiInputSchema({ type: "object", properties: {} })).toEqual({
      type: "object",
      properties: {},
      required: [],
    });
    expect(normalizeKimiInputSchema({})).toEqual({
      type: "object",
      properties: {},
      required: [],
    });
  });

  it("strips unsupported schema keywords", () => {
    const out = normalizeKimiInputSchema({
      type: "object",
      properties: {},
      not: {},
      $schema: "http://json-schema.org/draft-07/schema#",
    });
    expect(out.not).toBeUndefined();
    expect(out.$schema).toBeUndefined();
    expect(out.required).toEqual([]);
  });

  it("infers property type from anyOf/oneOf instead of forcing string", () => {
    const out = normalizeKimiInputSchema({
      type: "object",
      properties: {
        count: { anyOf: [{ type: "number" }, { type: "null" }] },
        flag: { oneOf: [{ type: "boolean" }] },
      },
    });
    expect(out.properties.count).toEqual({ type: "number" });
    expect(out.properties.flag).toEqual({ type: "boolean" });
  });

  it("forces thinking enabled for k2.7", () => {
    const body = { thinking: { type: "disabled" } };
    ensureKimiThinkingEnabled(body, "kimi-k2.7-code");
    expect(body.thinking).toEqual({ type: "enabled" });
  });

  it("prepareKimiRequest applies integrated fixes", () => {
    const body = {
      model: "kimi-k2.7-code",
      temperature: 0.5,
      tool_choice: { type: "tool", name: "Bash" },
      output_config: { format: "json" },
      tools: [{ name: "Read", input_schema: { type: "object", properties: {} } }],
    };
    prepareKimiRequest(body, "kimi-coding", body.model);
    expect(body.temperature).toBeUndefined();
    expect(body.tool_choice).toEqual({ type: "auto" });
    expect(body.output_config).toBeUndefined();
    expect(body.tools[0].input_schema.required).toEqual([]);
    expect(body.thinking).toEqual({ type: "enabled" });
  });
});

describe("prepareClaudeRequest — kimi integration", () => {
  it("normalizes kimi k2.7 requests end-to-end", () => {
    const body = {
      model: "kimi-k2.7-code",
      max_tokens: 8192,
      temperature: 0.8,
      tool_choice: { type: "any" },
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "Glob", description: "find files", input_schema: { type: "object", properties: {} } }],
    };
    const out = prepareClaudeRequest(structuredClone(body), "kimi-coding");
    expect(out.temperature).toBeUndefined();
    expect(out.tool_choice).toEqual({ type: "auto" });
    expect(out.tools[0].input_schema.required).toEqual([]);
    expect(out.thinking).toEqual({ type: "enabled" });
  });
});
