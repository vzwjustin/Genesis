/**
 * Claude / Anthropic prompt-cache preservation regressions.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyCloaking } from "../../open-sse/utils/claudeCloaking.js";
import {
  fixToolUseOrdering,
  prepareClaudeRequest,
  hasAnthropicCacheBreakpoints,
} from "../../open-sse/translator/helpers/claudeHelper.js";
import { injectCaveman } from "../../open-sse/rtk/caveman.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const OAUTH = "sk-ant-oat-test-token";

describe("applyCloaking — cache-safe system injection", () => {
  it("does not inject metadata when client already set cache_control breakpoints", () => {
    const body = {
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "hi", cache_control: { type: "ephemeral" } }],
    };
    const out = applyCloaking(structuredClone(body), OAUTH, "sess-123");
    expect(out.metadata).toBeUndefined();
    expect(out).toEqual(body);
  });

  it("does not touch system when client already set cache_control breakpoints", () => {
    const body = {
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "hi" }],
      system: [
        { type: "text", text: "cached prefix", cache_control: { type: "ephemeral", ttl: "1h" } },
        { type: "text", text: "tail" },
      ],
    };
    const out = applyCloaking(structuredClone(body), OAUTH, "sess-123");
    expect(out.system).toEqual(body.system);
    expect(out.system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("inserts billing AFTER the last cached system block when proxy adds cache itself", () => {
    const body = {
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "hi" }],
      system: [
        { type: "text", text: "prefix" },
        { type: "text", text: "tail" },
      ],
    };
    const out = applyCloaking(structuredClone(body), OAUTH, "sess-123");
    expect(out.system[0].text).toBe("prefix");
    expect(out.system[1].text).toBe("tail");
    expect(out.system[2].text).toContain("x-anthropic-billing-header:");
  });

  it("produces stable billing headers for identical bodies", () => {
    const body = { model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }] };
    const a = applyCloaking(structuredClone(body), OAUTH, "sess-a");
    const b = applyCloaking(structuredClone(body), OAUTH, "sess-b");
    const billingA = a.system.find((block) => block.text?.startsWith("x-anthropic-billing-header:"))?.text;
    const billingB = b.system.find((block) => block.text?.startsWith("x-anthropic-billing-header:"))?.text;
    expect(billingA).toBe(billingB);
  });

  it("derives stable metadata user_id from session id", () => {
    const body = { model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }] };
    const a = applyCloaking(structuredClone(body), OAUTH, "sess-stable");
    const b = applyCloaking(structuredClone(body), OAUTH, "sess-stable");
    expect(a.metadata.user_id).toBe(b.metadata.user_id);
    expect(a.metadata.user_id).toContain("sess-stable");
  });
});

describe("fixToolUseOrdering — cache markers", () => {
  it("does not merge messages when either side carries cache_control", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "a" }] },
      { role: "user", cache_control: { type: "ephemeral" }, content: [{ type: "text", text: "b" }] },
    ];
    const out = fixToolUseOrdering(messages);
    expect(out).toHaveLength(2);
    expect(out[1].cache_control).toEqual({ type: "ephemeral" });
  });
});

describe("prepareClaudeRequest — client cache breakpoints", () => {
  it("preserves thinking signatures when client already set cache_control", () => {
    const sig = "client-thinking-signature";
    const body = {
      model: "claude-sonnet-4-5",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hmm", signature: sig },
            { type: "text", text: "answer", cache_control: { type: "ephemeral" } },
          ],
        },
      ],
      thinking: { type: "enabled", budget_tokens: 1000 },
    };
    prepareClaudeRequest(body, "claude");
    expect(body.messages[1].content[0].signature).toBe(sig);
  });
});

describe("injectCaveman — Claude system cache boundary (no client breakpoints)", () => {
  it("inserts after the last cached system block", () => {
    const body = {
      system: [
        { type: "text", text: "cached", cache_control: { type: "ephemeral" } },
        { type: "text", text: "more" },
      ],
      messages: [{ role: "user", content: "hi" }],
    };
    injectCaveman(body, FORMATS.CLAUDE, "lite");
    expect(body.system[0].cache_control).toBeDefined();
    expect(body.system[1].text).toContain("Respond tersely");
    expect(body.system[2].text).toBe("more");
  });
});

describe("claudeHeaderCache — per-request session wins", () => {
  let cacheModule;

  beforeEach(async () => {
    vi.resetModules();
    cacheModule = await import("../../open-sse/utils/claudeHeaderCache.js");
  });

  it("overlays x-claude-code-session-id from the current request", () => {
    cacheModule.cacheClaudeHeaders({
      "user-agent": "claude-code/2.1.63",
      "x-claude-code-session-id": "stale-session",
    }, "conn-1");

    const merged = cacheModule.getCachedClaudeHeaders("conn-1", {
      "user-agent": "claude-code/2.1.63",
      "x-claude-code-session-id": "live-session",
    });

    expect(merged["x-claude-code-session-id"]).toBe("live-session");
  });
});

describe("RTK — strict cache floor", () => {
  it("does not compress tool results that appear before a cached assistant turn", async () => {
    const { compressMessages } = await import("../../open-sse/rtk/index.js");
    const big = "diff --git a/x b/x\n" + "line\n".repeat(400);
    const body = {
      messages: [
        { role: "user", content: "go" },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: big }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "done", cache_control: { type: "ephemeral" } }],
        },
      ],
    };
    const before = body.messages[1].content[0].content.length;
    compressMessages(body, true);
    expect(body.messages[1].content[0].content.length).toBe(before);
  });
});

describe("hasAnthropicCacheBreakpoints — cloak skip signal", () => {
  it("detects tool-level breakpoints used to skip OAuth tool renaming", () => {
    expect(hasAnthropicCacheBreakpoints({
      tools: [{ name: "Read", cache_control: { type: "ephemeral", ttl: "1h" } }],
      messages: [{ role: "user", content: "go" }],
    })).toBe(true);
  });
});
