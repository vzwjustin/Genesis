/**
 * Hard invariant: cache_control regions stay byte-for-byte identical.
 */
import { describe, it, expect } from "vitest";
import {
  snapshotCacheProtectedBody,
  verifyCacheProtectedBody,
  shouldSkipMessageForCache,
  hasAnthropicCacheBreakpoints,
} from "../../open-sse/rtk/cacheBoundary.js";

describe("cacheBoundary — snapshot and verify", () => {
  it("detects breakpoints on system, tools, and messages", () => {
    expect(hasAnthropicCacheBreakpoints({
      system: [{ type: "text", text: "x", cache_control: { type: "ephemeral" } }],
    })).toBe(true);
    expect(hasAnthropicCacheBreakpoints({
      tools: [{ name: "Read", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "hi" }],
    })).toBe(true);
  });

  it("verify fails when a protected message is mutated", () => {
    const body = {
      messages: [
        { role: "user", content: "cached", cache_control: { type: "ephemeral" } },
        { role: "tool", tool_call_id: "c1", content: "compressible ".repeat(100) },
      ],
    };
    const snap = snapshotCacheProtectedBody(body);
    body.messages[0].content = "TAMPERED";
    expect(verifyCacheProtectedBody(body, snap)).toBe(false);
  });

  it("verify passes when only post-boundary content changes", () => {
    const body = {
      messages: [
        { role: "assistant", content: [{ type: "text", text: "done", cache_control: { type: "ephemeral" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "big output" }] },
      ],
    };
    const snap = snapshotCacheProtectedBody(body);
    body.messages[1].content[0].content = "small";
    expect(verifyCacheProtectedBody(body, snap)).toBe(true);
  });

  it("verify fails when snapshotted tools array is deleted", () => {
    const body = {
      tools: [{ name: "Read", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "hi" }],
    };
    const snap = snapshotCacheProtectedBody(body);
    delete body.tools;
    expect(verifyCacheProtectedBody(body, snap)).toBe(false);
  });

  it("shouldSkipMessageForCache protects everything at or before floor", () => {
    const items = [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }] },
      { role: "assistant", content: [{ type: "text", text: "done", cache_control: { type: "ephemeral" } }] },
    ];
    expect(shouldSkipMessageForCache(0, items, 1)).toBe(true);
    expect(shouldSkipMessageForCache(1, items, 1)).toBe(true);
  });
});
