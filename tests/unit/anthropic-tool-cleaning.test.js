/**
 * Tests for Anthropic tool cleaning (Tasks 9.1–9.4)
 *
 * Requirements: 1.2, 1.6
 */
import { describe, it, expect } from "vitest";
import {
  cleanAnthropicToolDefinitions,
  hasAnthropicCacheBreakpoints,
  prepareClaudeRequest,
} from "../../open-sse/translator/helpers/claudeHelper.js";

describe("cleanAnthropicToolDefinitions — client tools (Requirement 1.6)", () => {
  it("strips model and type when type is missing", () => {
    const tools = [{ name: "get_weather", description: "Weather", input_schema: {}, model: "cc/gpt-4" }];
    const cleaned = cleanAnthropicToolDefinitions(tools, "claude");
    expect(cleaned[0]).toEqual({ name: "get_weather", description: "Weather", input_schema: {} });
    expect(cleaned[0].model).toBeUndefined();
    expect(cleaned[0].type).toBeUndefined();
  });

  it("strips model and type when type is function", () => {
    const tools = [{ type: "function", name: "search", description: "Search", input_schema: {}, model: "ignored" }];
    const cleaned = cleanAnthropicToolDefinitions(tools, "claude");
    expect(cleaned[0]).toEqual({ name: "search", description: "Search", input_schema: {} });
    expect(cleaned[0].type).toBeUndefined();
    expect(cleaned[0].model).toBeUndefined();
  });
});

describe("cleanAnthropicToolDefinitions — built-in tools (Requirement 1.6)", () => {
  it("preserves built-in tool properties", () => {
    const tools = [{
      type: "web_search_20250305",
      name: "web_search",
      max_uses: 5,
      model: "claude-opus-4-6",
    }];
    const cleaned = cleanAnthropicToolDefinitions(tools, "claude");
    expect(cleaned[0].type).toBe("web_search_20250305");
    expect(cleaned[0].name).toBe("web_search");
    expect(cleaned[0].max_uses).toBe(5);
    expect(cleaned[0].model).toBe("claude-opus-4-6");
  });

  it("strips provider prefix from built-in tool model (cc/)", () => {
    const tools = [{ type: "web_search_20250305", name: "web_search", model: "cc/claude-opus-4-6" }];
    const cleaned = cleanAnthropicToolDefinitions(tools, "claude");
    expect(cleaned[0].model).toBe("claude-opus-4-6");
    expect(cleaned[0].model).not.toContain("cc/");
  });

  it("strips provider prefix from built-in tool model (anthropic/)", () => {
    const tools = [{ type: "computer_20250124", name: "computer", model: "anthropic/claude-sonnet-4-5" }];
    const cleaned = cleanAnthropicToolDefinitions(tools, "claude");
    expect(cleaned[0].model).toBe("claude-sonnet-4-5");
  });

  it("preserves cache_control on client and built-in tools", () => {
    const tools = [
      { type: "function", name: "fn", input_schema: {}, cache_control: { type: "ephemeral" } },
      { type: "web_search_20250305", name: "web_search", cache_control: { type: "ephemeral", ttl: "1h" } },
    ];
    const cleaned = cleanAnthropicToolDefinitions(tools, "claude");
    expect(cleaned[0].cache_control).toEqual({ type: "ephemeral" });
    expect(cleaned[1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("filters built-in tools for non-claude providers", () => {
    const tools = [
      { type: "function", name: "client_tool", input_schema: {} },
      { type: "web_search_20250305", name: "web_search" },
    ];
    const cleaned = cleanAnthropicToolDefinitions(tools, "openrouter");
    expect(cleaned).toHaveLength(1);
    expect(cleaned[0].name).toBe("client_tool");
  });
});

describe("hasAnthropicCacheBreakpoints", () => {
  it("detects cache_control on system, tools, messages, and content blocks", () => {
    expect(hasAnthropicCacheBreakpoints({ system: [{ type: "text", text: "x", cache_control: { type: "ephemeral" } }] })).toBe(true);
    expect(hasAnthropicCacheBreakpoints({ tools: [{ name: "fn", cache_control: { type: "ephemeral" } }] })).toBe(true);
    expect(hasAnthropicCacheBreakpoints({ messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }] })).toBe(true);
    expect(hasAnthropicCacheBreakpoints({ messages: [{ role: "assistant", cache_control: { type: "ephemeral" }, content: "hi" }] })).toBe(true);
    expect(hasAnthropicCacheBreakpoints({ messages: [{ role: "user", content: "hi" }] })).toBe(false);
  });
});

describe("prepareClaudeRequest — integrated tool cleaning", () => {
  it("applies tool cleaning and adds cache_control on last tool when client sent none", () => {
    const body = {
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "Hi" }],
      tools: [
        { type: "function", name: "fn", input_schema: {}, model: "strip-me" },
        { type: "web_search_20250305", name: "web_search", model: "cc/claude-opus-4-6" },
      ],
    };
    prepareClaudeRequest(body, "claude");
    expect(body.tools[0].model).toBeUndefined();
    expect(body.tools[0].type).toBeUndefined();
    expect(body.tools[1].model).toBe("claude-opus-4-6");
    expect(body.tools[1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("preserves client cache_control layout when breakpoints already exist", () => {
    const body = {
      model: "claude-sonnet-4-5",
      system: [
        { type: "text", text: "cached system", cache_control: { type: "ephemeral", ttl: "1h" } },
        { type: "text", text: "uncached tail" },
      ],
      messages: [
        { role: "user", content: "Hi" },
        {
          role: "assistant",
          content: [{ type: "text", text: "cached turn", cache_control: { type: "ephemeral" } }],
        },
      ],
      tools: [
        { type: "function", name: "fn", input_schema: {}, model: "strip-me", cache_control: { type: "ephemeral" } },
        { type: "web_search_20250305", name: "web_search", model: "cc/claude-opus-4-6" },
      ],
    };
    prepareClaudeRequest(body, "claude");
    expect(body.system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(body.system[1].cache_control).toBeUndefined();
    expect(body.messages[1].content[0].cache_control).toEqual({ type: "ephemeral" });
    expect(body.tools[0].cache_control).toEqual({ type: "ephemeral" });
    expect(body.tools[0].model).toBeUndefined();
    expect(body.tools[1].cache_control).toBeUndefined();
    expect(body.tools[1].model).toBe("claude-opus-4-6");
  });
});

describe("passthrough compatibility fix (Task 9.3)", () => {
  function applyPassthroughToolCleaning(body, provider) {
    const translatedBody = { ...body };
    if ((provider === "claude" || provider?.startsWith("anthropic-compatible")) && Array.isArray(translatedBody.tools)) {
      translatedBody.tools = cleanAnthropicToolDefinitions(translatedBody.tools, provider);
      if (translatedBody.tools.length === 0) {
        delete translatedBody.tools;
        delete translatedBody.tool_choice;
      }
    }
    return translatedBody;
  }

  it("strips prefixed built-in tool model in passthrough without other translation", () => {
    const body = {
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "Search" }],
      tools: [{ type: "web_search_20250305", name: "web_search", model: "cc/claude-opus-4-6" }],
    };
    const result = applyPassthroughToolCleaning(body, "claude");
    expect(result.tools[0].model).toBe("claude-opus-4-6");
    expect(result.tools[0].type).toBe("web_search_20250305");
    expect(result.tools[0].cache_control).toBeUndefined();
  });

  it("preserves tool cache_control in passthrough", () => {
    const body = {
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "Search" }],
      tools: [{
        type: "web_search_20250305",
        name: "web_search",
        model: "cc/claude-opus-4-6",
        cache_control: { type: "ephemeral", ttl: "1h" },
      }],
    };
    const result = applyPassthroughToolCleaning(body, "claude");
    expect(result.tools[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("does not mutate tools for non-anthropic passthrough providers", () => {
    const body = {
      model: "gpt-4",
      tools: [{ type: "web_search_20250305", name: "web_search", model: "cc/gpt-4" }],
    };
    const result = applyPassthroughToolCleaning(body, "openai");
    expect(result.tools[0].model).toBe("cc/gpt-4");
    expect(result.tools[0].type).toBe("web_search_20250305");
  });
});
