/**
 * Extreme cache audit — executor bypass paths, codex prefetch floor, throwOnCacheViolation.
 */
import { describe, it, expect } from "vitest";
import {
  snapshotCacheProtectedBody,
  throwOnCacheViolation,
  verifyCacheProtectedBody,
  findLastCacheBoundary,
  shouldSkipMessageForCache,
} from "../../open-sse/rtk/cacheBoundary.js";
import { CodexExecutor } from "../../open-sse/executors/codex.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { QwenExecutor } from "../../open-sse/executors/qwen.js";
import { fixMissingToolResponses } from "../../open-sse/translator/helpers/toolCallHelper.js";

describe("throwOnCacheViolation", () => {
  it("throws cache_integrity_failed when protected message drifts", () => {
    const body = {
      messages: [
        { role: "user", content: "cached", cache_control: { type: "ephemeral" } },
        { role: "user", content: "tail" },
      ],
    };
    const snap = snapshotCacheProtectedBody(body);
    body.messages[0].content = "tampered";
    expect(() => throwOnCacheViolation(body, snap, "test")).toThrow(/modified after test/);
    try {
      throwOnCacheViolation(body, snap, "test");
    } catch (e) {
      expect(e.code).toBe("cache_integrity_failed");
    }
  });

  it("no-ops when snapshot is null", () => {
    expect(() => throwOnCacheViolation({ messages: [] }, null)).not.toThrow();
  });
});

describe("codex transformRequest — client cache layout", () => {
  it("skips input/tool normalization when input has cache_control", async () => {
    const ex = new CodexExecutor();
    const body = {
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }], cache_control: { type: "ephemeral" } },
        { type: "function_call_output", call_id: "c1", output: "big" },
      ],
      tools: [{ type: "function", name: "Read", parameters: { type: "object", properties: {} } }],
    };
    const snap = JSON.stringify(body.input[0]);
    await ex.transformRequest("gpt-5", body, true, {});
    expect(JSON.stringify(body.input[0])).toBe(snap);
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
  });
});

describe("executor transform guards", () => {
  it("default executor skips reasoning injection when breakpoints exist", () => {
    const ex = new DefaultExecutor("openai");
    const body = {
      messages: [
        { role: "assistant", content: "x", cache_control: { type: "ephemeral" } },
      ],
    };
    const out = ex.transformRequest("gpt-4", body);
    expect(out).toBe(body);
    expect(out.messages[0].reasoning_content).toBeUndefined();
  });

  it("qwen executor skips default system injection when breakpoints exist", () => {
    const ex = new QwenExecutor();
    const body = {
      messages: [{ role: "user", content: "hi", cache_control: { type: "ephemeral" } }],
    };
    const out = ex.transformRequest("qwen", body, true, {});
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0].role).toBe("user");
  });
});

describe("fixMissingToolResponses — openai format cache floor", () => {
  it("does not splice tool responses before the cache boundary", () => {
    const body = {
      messages: [
        { role: "assistant", tool_calls: [{ id: "call_a", type: "function", function: { name: "t", arguments: "{}" } }] },
        { role: "user", content: "cached", cache_control: { type: "ephemeral" } },
        { role: "user", content: "after" },
      ],
    };
    const before = body.messages.length;
    fixMissingToolResponses(body);
    expect(body.messages.length).toBe(before);
  });
});

describe("input cache floor helpers", () => {
  it("shouldSkipMessageForCache protects input[] prefix for codex prefetch", () => {
    const input = [
      { type: "message", role: "user", cache_control: { type: "ephemeral" }, content: [] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "tail" }] },
    ];
    const floor = findLastCacheBoundary(input);
    expect(shouldSkipMessageForCache(0, input, floor)).toBe(true);
    expect(shouldSkipMessageForCache(1, input, floor)).toBe(false);
  });
});
