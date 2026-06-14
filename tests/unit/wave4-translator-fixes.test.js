/**
 * Wave 4 — translator / executor audit fixes (c9c862e2 + bef05e35)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { claudeToOpenAIRequest } from "../../open-sse/translator/request/claude-to-openai.js";
import { claudeToOpenAIResponse } from "../../open-sse/translator/response/claude-to-openai.js";
import { openaiToClaudeRequest } from "../../open-sse/translator/request/openai-to-claude.js";
import {
  openaiToGeminiRequest,
  openaiToGeminiCLIRequest,
} from "../../open-sse/translator/request/openai-to-gemini.js";
import { geminiToOpenAIResponse } from "../../open-sse/translator/response/gemini-to-openai.js";
import { antigravityToOpenAIRequest } from "../../open-sse/translator/request/antigravity-to-openai.js";
import { prepareClaudeRequest, cleanAnthropicToolDefinitions } from "../../open-sse/translator/helpers/claudeHelper.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { injectReasoningContent } from "../../open-sse/utils/reasoningContentInjector.js";

describe("claudeToOpenAIResponse — usage optional chaining", () => {
  it("message_stop does not throw when state.usage is undefined", () => {
    const state = {
      messageId: "msg_test",
      model: "claude-sonnet-4-5",
      toolCalls: new Map(),
      finishReasonSent: false,
    };
    const chunks = claudeToOpenAIResponse({ type: "message_stop" }, state);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].choices[0].finish_reason).toBe("stop");
    expect(chunks[0].usage).toBeUndefined();
  });
});

describe("claudeToOpenAIRequest — tool_choice none and reasoning-only content", () => {
  it('maps tool_choice type "none" to OpenAI "none"', () => {
    const out = claudeToOpenAIRequest("gpt-4o", { messages: [], tool_choice: { type: "none" } }, false);
    expect(out.tool_choice).toBe("none");
  });

  it('maps string tool_choice "none" to OpenAI "none"', () => {
    const out = claudeToOpenAIRequest("gpt-4o", { messages: [], tool_choice: "none" }, false);
    expect(out.tool_choice).toBe("none");
  });

  it("uses empty string content when only reasoningContent is present", () => {
    const out = claudeToOpenAIRequest("gpt-4o", {
      messages: [{
        role: "assistant",
        content: [{ type: "thinking", thinking: "hidden" }],
      }],
    }, false);
    const assistant = out.messages.find((m) => m.role === "assistant");
    expect(assistant.content).toBe("");
    expect(assistant.reasoning_content).toBe("hidden");
  });

  it("warns on non-text system blocks instead of silently dropping", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = claudeToOpenAIRequest("gpt-4o", {
      system: [
        { type: "text", text: "hello" },
        { type: "document", source: { type: "text", data: "doc" } },
      ],
      messages: [{ role: "user", content: "hi" }],
    }, false);
    expect(out.messages[0].content).toBe("hello");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("document"));
    warn.mockRestore();
  });
});

describe("openaiToGemini — functionResponse and systemInstruction", () => {
  it("does not double-wrap functionResponse result", () => {
    const out = openaiToGeminiCLIRequest("gemini-2.5-pro", {
      messages: [
        {
          role: "assistant",
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: "{}" },
          }],
        },
        { role: "tool", tool_call_id: "call_1", content: '{"temp":72}' },
      ],
      tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object", properties: {} } } }],
    }, true);

    const responsePart = out.contents
      .flatMap((c) => c.parts)
      .find((p) => p.functionResponse);
    expect(responsePart.functionResponse.response).toEqual({ result: { temp: 72 } });
    expect(responsePart.functionResponse.response.result).not.toHaveProperty("result");
  });

  it("routes single system message to systemInstruction not user contents", () => {
    const out = openaiToGeminiRequest("gemini-2.5-pro", {
      messages: [{ role: "system", content: "You are helpful" }],
    }, false);
    expect(out.systemInstruction).toEqual({ parts: [{ text: "You are helpful" }] });
    expect(out.systemInstruction.role).toBeUndefined();
    expect(out.contents).toHaveLength(0);
  });

  it("omits thoughtSignature on standard Gemini path", () => {
    const out = openaiToGeminiRequest("gemini-2.5-pro", {
      messages: [{
        role: "assistant",
        reasoning_content: "thinking",
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "fn", arguments: "{}" },
        }],
      }],
    }, false);
    const parts = out.contents.flatMap((c) => c.parts);
    expect(parts.some((p) => p.thoughtSignature)).toBe(false);
    expect(parts.some((p) => p.thought === true)).toBe(true);
  });

  it("includes thoughtSignature on CLI/Antigravity path", () => {
    const out = openaiToGeminiCLIRequest("gemini-2.5-pro", {
      messages: [{
        role: "assistant",
        reasoning_content: "thinking",
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "fn", arguments: "{}" },
        }],
      }],
    }, true);
    const parts = out.contents.flatMap((c) => c.parts);
    expect(parts.some((p) => p.thoughtSignature)).toBe(true);
  });

  it("maps reasoning_effort none to thinkingBudget 0", () => {
    const out = openaiToGeminiCLIRequest("gemini-2.5-pro", {
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "none",
    }, true);
    expect(out.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
  });

  it("aligns reasoning_effort budget map with Claude translator", () => {
    const out = openaiToGeminiCLIRequest("gemini-2.5-pro", {
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "low",
    }, true);
    expect(out.generationConfig.thinkingConfig.thinkingBudget).toBe(4096);
  });

  it("exposes _toolNameMap for reverse name lookup", () => {
    const out = openaiToGeminiRequest("gemini-2.5-pro", {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "my.tool:name", parameters: { type: "object", properties: {} } } }],
    }, false);
    expect(out._toolNameMap).toBeInstanceOf(Map);
    const geminiName = [...out._toolNameMap.keys()][0];
    expect(out._toolNameMap.get(geminiName)).toBe("my.tool:name");
    expect(geminiName).not.toContain(".");
    expect(geminiName).not.toContain(":");
  });
});

describe("geminiToOpenAIResponse — toolNameMap reverse lookup", () => {
  it("restores original tool name via state.toolNameMap", () => {
    const toolNameMap = new Map([["my_tool_name", "my.tool:name"]]);
    const state = { toolCalls: new Map(), toolNameMap, functionIndex: 0 };
    const chunks = geminiToOpenAIResponse({
      candidates: [{
        content: {
          parts: [{
            functionCall: { name: "my_tool_name", args: { q: 1 } },
          }],
        },
        finishReason: "STOP",
      }],
    }, state);
    const toolChunk = chunks.find((c) => c.choices[0].delta.tool_calls);
    expect(toolChunk.choices[0].delta.tool_calls[0].function.name).toBe("my.tool:name");
  });
});

describe("openaiToClaude — budget_tokens and tool_choice", () => {
  it("preserves budget_tokens when value is 0", () => {
    const out = openaiToClaudeRequest("claude-sonnet-4-5", {
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled", budget_tokens: 0 },
    }, false);
    expect(out.thinking.budget_tokens).toBe(0);
  });

  it("skips tools without name", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = openaiToClaudeRequest("claude-sonnet-4-5", {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { description: "bad" } }],
    }, false);
    expect(out.tools).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("without name"));
    warn.mockRestore();
  });

  it("prefixes tool_choice function name with CLAUDE_OAUTH_TOOL_PREFIX", () => {
    const out = openaiToClaudeRequest("claude-sonnet-4-5", {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "search", parameters: { type: "object", properties: {} } } }],
      tool_choice: { type: "function", function: { name: "search" } },
    }, false);
    expect(out.tool_choice).toEqual({ type: "tool", name: "search" });
  });
});

describe("antigravityToOpenAI — functionResponse id and mixed content", () => {
  it("skips functionResponse without id instead of falling back to name", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = antigravityToOpenAIRequest("gemini-2.5-pro", {
      request: {
        contents: [{
          role: "user",
          parts: [{
            functionResponse: {
              name: "fn",
              response: { result: "ok" },
            },
          }],
        }],
      },
    }, false);
    expect(out.messages.filter((m) => m.role === "tool")).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("without id"));
    warn.mockRestore();
  });

  it("includes both tool results and trailing user text", () => {
    const out = antigravityToOpenAIRequest("gemini-2.5-pro", {
      request: {
        contents: [{
          role: "user",
          parts: [
            { functionResponse: { id: "call_1", name: "fn", response: { result: "ok" } } },
            { text: "follow-up question" },
          ],
        }],
      },
    }, false);
    expect(out.messages).toHaveLength(2);
    expect(out.messages[0]).toMatchObject({ role: "tool", tool_call_id: "call_1" });
    expect(out.messages[1]).toMatchObject({ role: "user", content: "follow-up question" });
  });
});

describe("prepareClaudeRequest — preserveClientCache for tools", () => {
  it("passes preserveClientCache to cleanAnthropicToolDefinitions on normal path", () => {
    const body = {
      messages: [{ role: "user", content: "hi" }],
      tools: [{
        type: "web_search_20250305",
        name: "web_search",
        model: "cc/claude-opus-4-6",
      }],
    };
    const out = prepareClaudeRequest(structuredClone(body), "claude");
    expect(out.tools[0].model).toBe("claude-opus-4-6");
  });

  it("preserves cached tool bytes when client owns cache layout", () => {
    const body = {
      system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }],
      tools: [{
        type: "function",
        name: "fn",
        model: "strip-me",
        cache_control: { type: "ephemeral" },
        input_schema: {},
      }],
    };
    const out = prepareClaudeRequest(structuredClone(body), "claude");
    expect(out.tools[0]).toEqual(body.tools[0]);
  });
});

describe("DefaultExecutor.transformRequest — cache breakpoints", () => {
  it("still runs injectReasoningContent when cache breakpoints are present", () => {
    const executor = new DefaultExecutor("deepseek");
    const body = {
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "answer",
          tool_calls: [{ id: "tc1", type: "function", function: { name: "fn", arguments: "{}" } }],
          cache_control: { type: "ephemeral" },
        },
      ],
    };
    const out = executor.transformRequest("deepseek-chat", body);
    const assistant = out.messages.find((m) => m.role === "assistant");
    expect(assistant.reasoning_content).toBe(" ");
    expect(out.messages[0].cache_control).toBeUndefined();
  });

  it("skips json_schema fallback when cache breakpoints are present", () => {
    const executor = new DefaultExecutor("openai-compatible-test");
    const body = {
      messages: [{ role: "user", content: "hi", cache_control: { type: "ephemeral" } }],
      response_format: {
        type: "json_schema",
        json_schema: { schema: { type: "object", properties: { x: { type: "string" } } } },
      },
    };
    const out = executor.transformRequest("gpt-4o", body);
    expect(out.response_format.type).toBe("json_schema");
  });
});

describe("cleanAnthropicToolDefinitions — sanitize via gemini name collision", () => {
  it("strips dots and colons from sanitized gemini names via openai-to-gemini", () => {
    const out = openaiToGeminiRequest("gemini-2.5-pro", {
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { type: "function", function: { name: "a.b", parameters: { type: "object", properties: {} } } },
        { type: "function", function: { name: "a:b", parameters: { type: "object", properties: {} } } },
      ],
    }, false);
    const names = out.tools[0].functionDeclarations.map((d) => d.name);
    expect(names[0]).toBe("a_b");
    expect(names[1]).toBe("a_b_2");
  });
});
