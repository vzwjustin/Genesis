/**
 * Cache audit — every mutation point must preserve byte-identical cache_control regions.
 */
import { describe, it, expect } from "vitest";
import {
  snapshotCacheProtectedBody,
  verifyCacheProtectedBody,
} from "../../open-sse/rtk/cacheBoundary.js";
import {
  cleanAnthropicToolDefinitions,
  fixToolUseOrdering,
  prepareClaudeRequest,
} from "../../open-sse/translator/helpers/claudeHelper.js";
import { compressMessages } from "../../open-sse/rtk/index.js";

describe("cache audit — tool cleaning", () => {
  it("leaves tools at or before the last cached tool index byte-identical", () => {
    const tools = [
      { name: "a", type: "function", model: "keep", input_schema: { type: "object", properties: {} } },
      { name: "b", type: "function", model: "strip-me", cache_control: { type: "ephemeral" }, input_schema: { type: "object", properties: {} } },
    ];
    const out = cleanAnthropicToolDefinitions(tools, "claude", { preserveClientCache: true });
    expect(out[0]).toEqual(tools[0]);
    expect(out[1]).toEqual(tools[1]);
  });

  it("preserves cached client tools byte-identical (no model/type strip)", () => {
    const tools = [
      {
        name: "my_tool",
        type: "function",
        model: "should-stay",
        cache_control: { type: "ephemeral", ttl: "1h" },
        input_schema: { type: "object", properties: {} },
      },
    ];
    const out = cleanAnthropicToolDefinitions(tools, "claude", { preserveClientCache: true });
    expect(out[0]).toEqual(tools[0]);
  });

  it("strips cc/ model prefix on cached built-in tools", () => {
    const tools = [
      {
        type: "bash",
        name: "Bash",
        model: "cc/claude-opus-4-6",
        cache_control: { type: "ephemeral" },
      },
    ];
    const out = cleanAnthropicToolDefinitions(tools, "claude", { preserveClientCache: true });
    expect(out[0].model).toBe("claude-opus-4-6");
    expect(out[0].cache_control).toEqual(tools[0].cache_control);
  });
});

describe("cache audit — fixToolUseOrdering pass 1", () => {
  it("does not strip assistant text after tool_use when message has cache_control", () => {
    const messages = [
      {
        role: "assistant",
        cache_control: { type: "ephemeral" },
        content: [
          { type: "tool_use", id: "t1", name: "Read", input: {} },
          { type: "text", text: "after tool text must stay" },
        ],
      },
    ];
    const out = fixToolUseOrdering(messages);
    expect(out[0].content).toHaveLength(2);
    expect(out[0].content[1].text).toBe("after tool text must stay");
  });
});

describe("cache audit — prepareClaudeRequest early exit", () => {
  it("leaves messages and tools untouched when client set cache breakpoints", () => {
    const body = {
      model: "claude-sonnet-4-5",
      system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
      tools: [
        {
          name: "Read",
          type: "function",
          model: "strip-me",
          cache_control: { type: "ephemeral" },
          input_schema: { type: "object", properties: {} },
        },
      ],
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: "Read", input: {} },
            { type: "text", text: "trailing", cache_control: { type: "ephemeral" } },
          ],
        },
      ],
    };
    const snap = snapshotCacheProtectedBody(body);
    const clone = structuredClone(body);
    prepareClaudeRequest(clone, "claude", "sk-ant-oat-test");
    expect(verifyCacheProtectedBody(clone, snap)).toBe(true);
    expect(clone.tools[0]).toEqual(body.tools[0]);
    expect(clone.messages[1].content).toHaveLength(2);
  });
});

describe("cache audit — RTK compression boundary", () => {
  it("never mutates messages at or before the last cache breakpoint", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "cached result" }],
          cache_control: { type: "ephemeral" },
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t2", content: "x".repeat(5000) }],
        },
      ],
    };
    const snap = snapshotCacheProtectedBody(body);
    compressMessages(body, true, null);
    expect(verifyCacheProtectedBody(body, snap)).toBe(true);
    expect(body.messages[0].content[0].content).toBe("cached result");
    expect(JSON.stringify(body.messages[0])).toBe(snap.messages[0]);
  });
});
