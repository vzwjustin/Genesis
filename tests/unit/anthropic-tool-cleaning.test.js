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
  usesAnthropicToolCleaning,
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

  it("remaps Fable/Mythos built-in tool models to claude-opus-4-8", () => {
    const cases = [
      "cc/claude-fable-5",
      "Claude Fable 5",
      "claude-mythos-5",
    ];
    for (const model of cases) {
      const cleaned = cleanAnthropicToolDefinitions(
        [{ type: "web_search_20250305", name: "web_search", model }],
        "claude",
      );
      expect(cleaned[0].model).toBe("claude-opus-4-8");
    }
  });

  it("strips cu/ cursor prefix from built-in tool model", () => {
    const tools = [{ type: "bash_20250124", name: "bash", model: "cu/claude-opus-4-8-high" }];
    const cleaned = cleanAnthropicToolDefinitions(tools, "claude");
    expect(cleaned[0].model).toBe("claude-opus-4-8-high");
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

  it("preserves built-in tools for anthropic-compatible providers", () => {
    const tools = [
      { type: "function", name: "client_tool", input_schema: {} },
      { type: "web_search_20250305", name: "web_search", model: "cc/claude-opus-4-6" },
    ];
    const cleaned = cleanAnthropicToolDefinitions(tools, "anthropic-compatible-minimax");
    expect(cleaned).toHaveLength(2);
    expect(cleaned[1].type).toBe("web_search_20250305");
    expect(cleaned[1].model).toBe("claude-opus-4-6");
  });
});

describe("cleanAnthropicToolDefinitions — MiniMax cache-protected built-ins", () => {
  it("keeps cached built-in tools byte-identical on minimax instead of dropping them", () => {
    const tools = [
      { type: "web_search_20250305", name: "web_search", model: "cc/claude-opus-4-6", cache_control: { type: "ephemeral" } },
      { type: "function", name: "fn", model: "strip-me", input_schema: {} },
    ];
    const out = cleanAnthropicToolDefinitions(tools, "minimax", { preserveClientCache: true });
    expect(out).toHaveLength(2);
    expect(out[0].model).toBe("claude-opus-4-6");
    expect(out[0].cache_control).toEqual(tools[0].cache_control);
    expect(out[1].model).toBeUndefined();
  });

  it("still drops uncached built-in tools on minimax when client owns no cache layout", () => {
    const tools = [
      { type: "web_search_20250305", name: "web_search", model: "cc/claude-opus-4-6" },
      { type: "function", name: "fn", input_schema: {} },
    ];
    const out = cleanAnthropicToolDefinitions(tools, "minimax");
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("fn");
  });

  it("does not change claude cached built-in prefix behavior", () => {
    const tools = [
      { type: "web_search_20250305", name: "web_search", model: "cc/claude-opus-4-6", cache_control: { type: "ephemeral" } },
      { type: "function", name: "fn", model: "x", input_schema: {} },
    ];
    const out = cleanAnthropicToolDefinitions(tools, "claude", { preserveClientCache: true });
    expect(out[0].model).toBe("claude-opus-4-6");
    expect(out[1].model).toBeUndefined();
  });

  it("keeps cached built-in tools byte-identical on openai provider", () => {
    const tools = [
      { type: "web_search_20250305", name: "web_search", model: "cc/claude-opus-4-6", cache_control: { type: "ephemeral" } },
      { type: "function", name: "fn", model: "strip-me", input_schema: {} },
    ];
    const out = cleanAnthropicToolDefinitions(tools, "openai", { preserveClientCache: true });
    expect(out).toHaveLength(2);
    expect(out[0].model).toBe("claude-opus-4-6");
    expect(out[0].cache_control).toEqual(tools[0].cache_control);
    expect(out[1].model).toBeUndefined();
  });

  it("keeps cached built-in tools byte-identical on gemini provider", () => {
    const tools = [
      { type: "web_search_20250305", name: "web_search", model: "cc/claude-opus-4-6", cache_control: { type: "ephemeral" } },
      { type: "function", name: "fn", model: "strip-me", input_schema: {} },
    ];
    const out = cleanAnthropicToolDefinitions(tools, "gemini", { preserveClientCache: true });
    expect(out).toHaveLength(2);
    expect(out[0].model).toBe("claude-opus-4-6");
    expect(out[0].cache_control).toEqual(tools[0].cache_control);
    expect(out[1].model).toBeUndefined();
  });
});

describe("usesAnthropicToolCleaning", () => {
  it("includes claude and claude-messages API providers", () => {
    expect(usesAnthropicToolCleaning("claude")).toBe(true);
    expect(usesAnthropicToolCleaning("anthropic-compatible-x")).toBe(true);
    expect(usesAnthropicToolCleaning("minimax")).toBe(true);
    expect(usesAnthropicToolCleaning("glm")).toBe(true);
  });

  it("does not include OpenAI/Gemini target schemas even when client owns cache breakpoints", () => {
    expect(usesAnthropicToolCleaning("openai", false)).toBe(false);
    expect(usesAnthropicToolCleaning("openai", true)).toBe(false);
    expect(usesAnthropicToolCleaning("gemini", false)).toBe(false);
    expect(usesAnthropicToolCleaning("gemini", true)).toBe(false);
    expect(usesAnthropicToolCleaning("gemini-cli", true)).toBe(false);
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
        { type: "web_search_20250305", name: "web_search", model: "Claude Fable 5" },
      ],
    };
    prepareClaudeRequest(body, "claude");
    expect(body.system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(body.system[1].cache_control).toBeUndefined();
    expect(body.messages[1].content[0].cache_control).toEqual({ type: "ephemeral" });
    expect(body.tools[0].cache_control).toEqual({ type: "ephemeral" });
    expect(body.tools[0].model).toBe("strip-me");
    expect(body.tools[0].type).toBe("function");
    expect(body.tools[1].cache_control).toBeUndefined();
    expect(body.tools[1].model).toBe("claude-opus-4-8");
  });
});

describe("passthrough compatibility fix (Task 9.3)", () => {
  function applyPassthroughToolCleaning(body, provider) {
    const translatedBody = { ...body };
    const hasBreakpoints = Array.isArray(translatedBody.tools) && translatedBody.tools.some((t) => t?.cache_control)
      || Array.isArray(translatedBody.system) && translatedBody.system.some((b) => b?.cache_control)
      || Array.isArray(translatedBody.messages) && translatedBody.messages.some((m) => m?.cache_control);
    if (
      (provider === "claude" || provider?.startsWith("anthropic-compatible"))
      && Array.isArray(translatedBody.tools)
    ) {
      translatedBody.tools = cleanAnthropicToolDefinitions(translatedBody.tools, provider, {
        preserveClientCache: hasBreakpoints,
      });
      if (translatedBody.tools.length === 0 && !hasBreakpoints) {
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

  it("preserves built-in tools in passthrough for anthropic-compatible providers", () => {
    const body = {
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "Search" }],
      tools: [{ type: "web_search_20250305", name: "web_search", model: "cc/claude-opus-4-6" }],
    };
    const result = applyPassthroughToolCleaning(body, "anthropic-compatible-minimax");
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].type).toBe("web_search_20250305");
    expect(result.tools[0].model).toBe("claude-opus-4-6");
  });

  it("normalizes prefixed built-in tool model on cache-protected passthrough tools", () => {
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
    expect(result.tools[0].model).toBe("claude-opus-4-6");
    expect(result.tools[0].cache_control).toEqual(body.tools[0].cache_control);
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
