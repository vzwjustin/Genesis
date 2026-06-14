/**
 * Wave 2 — translator / caveman behavioral fixes
 */
import { describe, it, expect } from "vitest";
import { injectCaveman } from "../../open-sse/rtk/caveman.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import {
  stripProviderModelPrefix,
  cleanAnthropicToolDefinitions,
} from "../../open-sse/translator/helpers/claudeHelper.js";
import { claudeToOpenAIRequest } from "../../open-sse/translator/request/claude-to-openai.js";
import { claudeToOpenAIResponse } from "../../open-sse/translator/response/claude-to-openai.js";

describe("caveman — Chat Completions array content", () => {
  it("appends { type: text } not input_text to array system content", () => {
    const body = {
      messages: [{
        role: "system",
        content: [{ type: "text", text: "existing" }],
      }],
    };
    injectCaveman(body, FORMATS.OPENAI, "full");
    const last = body.messages[0].content.at(-1);
    expect(last).toEqual({ type: "text", text: expect.stringContaining("caveman") });
    expect(last.type).not.toBe("input_text");
  });
});

describe("stripProviderModelPrefix — known prefixes only", () => {
  it("strips known provider prefixes", () => {
    expect(stripProviderModelPrefix("cc/claude-opus-4-6")).toBe("claude-opus-4-6");
    expect(stripProviderModelPrefix("anthropic/claude-sonnet-4-5")).toBe("claude-sonnet-4-5");
  });

  it("does not strip unknown generic path segments", () => {
    expect(stripProviderModelPrefix("provider/cc/claude-opus-4-6")).toBe("provider/cc/claude-opus-4-6");
  });
});

describe("cleanAnthropicToolDefinitions — toolProtected built-in model strip", () => {
  it("strips cc/ from cached built-in tool model while preserving cache_control", () => {
    const tools = [{
      type: "web_search_20250305",
      name: "web_search",
      model: "cc/claude-opus-4-6",
      cache_control: { type: "ephemeral", ttl: "1h" },
    }];
    const out = cleanAnthropicToolDefinitions(tools, "claude", { preserveClientCache: true });
    expect(out[0].model).toBe("claude-opus-4-6");
    expect(out[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(out[0].type).toBe("web_search_20250305");
  });

  it("leaves protected client tools byte-identical", () => {
    const tools = [{
      name: "fn",
      type: "function",
      model: "keep-me",
      cache_control: { type: "ephemeral" },
      input_schema: {},
    }];
    const out = cleanAnthropicToolDefinitions(tools, "claude", { preserveClientCache: true });
    expect(out[0]).toEqual(tools[0]);
  });
});

describe("claudeToOpenAIRequest — thinking and images", () => {
  it("maps thinking blocks to reasoning_content", () => {
    const body = {
      messages: [{
        role: "assistant",
        content: [
          { type: "thinking", thinking: "internal reasoning" },
          { type: "text", text: "visible answer" },
        ],
      }],
    };
    const out = claudeToOpenAIRequest("gpt-4o", body, false);
    const assistant = out.messages.find((m) => m.role === "assistant");
    expect(assistant.reasoning_content).toBe("internal reasoning");
    expect(assistant.content).toBe("visible answer");
  });

  it("skips redacted_thinking blocks", () => {
    const body = {
      messages: [{
        role: "assistant",
        content: [
          { type: "redacted_thinking", data: "secret" },
          { type: "text", text: "answer" },
        ],
      }],
    };
    const out = claudeToOpenAIRequest("gpt-4o", body, false);
    const assistant = out.messages.find((m) => m.role === "assistant");
    expect(assistant.reasoning_content).toBeUndefined();
    expect(assistant.content).toBe("answer");
  });

  it("converts image url source to image_url", () => {
    const body = {
      messages: [{
        role: "user",
        content: [{
          type: "image",
          source: { type: "url", url: "https://example.com/photo.png" },
        }],
      }],
    };
    const out = claudeToOpenAIRequest("gpt-4o", body, false);
    const user = out.messages.find((m) => m.role === "user");
    expect(user.content[0]).toEqual({
      type: "image_url",
      image_url: { url: "https://example.com/photo.png" },
    });
  });
});

describe("claudeToOpenAIResponse — server tools and usage", () => {
  function makeState() {
    return {
      messageId: "msg_test",
      model: "claude-sonnet-4-5",
      toolCallIndex: 0,
      toolCalls: new Map(),
      finishReasonSent: false,
    };
  }

  it("tracks multiple server_tool_use blocks via Set", () => {
    const state = makeState();
    claudeToOpenAIResponse({ type: "content_block_start", index: 1, content_block: { type: "server_tool_use" } }, state);
    claudeToOpenAIResponse({ type: "content_block_start", index: 3, content_block: { type: "server_tool_use" } }, state);
    expect(state.serverToolBlockIndexes).toEqual(new Set([1, 3]));

    const delta1 = claudeToOpenAIResponse({
      type: "content_block_delta",
      index: 1,
      delta: { type: "text_delta", text: "skip" },
    }, state);
    expect(delta1).toBeNull();

    const delta2 = claudeToOpenAIResponse({
      type: "content_block_delta",
      index: 2,
      delta: { type: "text_delta", text: "keep" },
    }, state);
    expect(delta2).not.toBeNull();
  });

  it("message_stop prefers prompt_tokens over input_tokens", () => {
    const state = makeState();
    state.usage = {
      prompt_tokens: 1500,
      completion_tokens: 200,
      input_tokens: 1000,
      output_tokens: 200,
    };
    const chunks = claudeToOpenAIResponse({ type: "message_stop" }, state);
    expect(chunks[0].usage.prompt_tokens).toBe(1500);
    expect(chunks[0].usage.completion_tokens).toBe(200);
    expect(chunks[0].usage.total_tokens).toBe(1700);
  });
});
