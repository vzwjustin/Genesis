/**
 * Regression tests for bug-hunt fixes
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { compressMessages } from "../../open-sse/rtk/index.js";

describe("Headroom — skip messages[] tails with tool history", () => {
  const originalFetch = globalThis.fetch;
  const compress = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    globalThis.fetch = vi.fn(async () => ({ ok: true }));
    compress.mockReset();
    vi.doMock("headroom-ai", () => ({ compress }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("does not compress when tail contains tool role messages", async () => {
    const body = {
      messages: [
        { role: "user", content: "cached", cache_control: { type: "ephemeral" } },
        { role: "assistant", content: "I'll check", tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: "x".repeat(5000) },
        { role: "user", content: "thanks" },
      ],
    };
    const snapshot = structuredClone(body.messages);

    const { compressWithHeadroom } = await import("../../open-sse/rtk/headroom.js");
    const result = await compressWithHeadroom(body, "gpt-4");

    expect(result).toBeNull();
    expect(compress).not.toHaveBeenCalled();
    expect(body.messages).toEqual(snapshot);
  });

  it("does not compress when tail contains Claude tool_result blocks", async () => {
    const body = {
      messages: [
        { role: "user", content: "cached", cache_control: { type: "ephemeral" } },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "output ".repeat(200) }],
        },
      ],
    };
    const snapshot = structuredClone(body.messages);

    const { compressWithHeadroom } = await import("../../open-sse/rtk/headroom.js");
    const result = await compressWithHeadroom(body, "claude-sonnet");

    expect(result).toBeNull();
    expect(compress).not.toHaveBeenCalled();
    expect(body.messages).toEqual(snapshot);
  });
});

describe("RTK — Gemini contents rollback on error", () => {
  let callCount = 0;

  beforeEach(() => {
    callCount = 0;
    vi.resetModules();
    vi.doMock("../../open-sse/rtk/applyFilter.js", () => ({
      safeApply: (filterName, text) => {
        callCount += 1;
        if (callCount === 2) throw new Error("simulated filter failure");
        return text;
      },
    }));
  });

  afterEach(() => {
    vi.doUnmock("../../open-sse/rtk/applyFilter.js");
  });

  it("restores gemini contents when compression throws mid-loop", async () => {
    const longText = "tool output ".repeat(400);
    const contents = [{
      parts: [
        { functionResponse: { response: { result: longText } } },
        { functionResponse: { response: { result: longText } } },
      ],
    }];
    const body = { contents };
    const before = JSON.stringify(contents);

    const { compressMessages: compressMessagesMocked } = await import("../../open-sse/rtk/index.js");
    const result = compressMessagesMocked(body, true);

    expect(result).toBeNull();
    expect(JSON.stringify(contents)).toBe(before);
  });
});

describe("RTK — Kiro currentMessage rollback on error", () => {
  let callCount = 0;

  beforeEach(() => {
    callCount = 0;
    vi.resetModules();
    vi.doMock("../../open-sse/rtk/applyFilter.js", () => ({
      safeApply: (filterName, text) => {
        callCount += 1;
        if (callCount === 2) throw new Error("simulated filter failure");
        return text;
      },
    }));
  });

  afterEach(() => {
    vi.doUnmock("../../open-sse/rtk/applyFilter.js");
  });

  it("restores currentMessage when kiro compression throws", async () => {
    const longText = "tool output ".repeat(400);
    const body = {
      conversationState: {
        currentMessage: {
          userInputMessage: {
            userInputMessageContext: {
              toolResults: [
                {
                  content: [{ text: longText }],
                },
                {
                  content: [{ text: longText }],
                },
              ],
            },
          },
        },
      },
    };
    const before = JSON.stringify(body.conversationState.currentMessage);

    const { compressMessages: compressMessagesMocked } = await import("../../open-sse/rtk/index.js");
    const result = compressMessagesMocked(body, true);

    expect(result).toBeNull();
    expect(JSON.stringify(body.conversationState.currentMessage)).toBe(before);
  });
});
