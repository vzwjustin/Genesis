/**
 * Headroom Responses API input[] rebuild — preserve tool call pairs
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("compressWithHeadroom input[] tool pairing", () => {
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

  it("preserves function_call items when headroom drops leading messages", async () => {
    const functionCall = {
      type: "function_call",
      call_id: "call_1",
      name: "bash",
      arguments: "{}",
    };
    const functionOutput = {
      type: "function_call_output",
      call_id: "call_1",
      output: "ok",
    };
    const userMsg = {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "old user turn to drop" }],
    };
    const assistantMsg = {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "kept assistant reply" }],
    };

    const body = {
      input: [
        { type: "message", role: "user", content: "cached", cache_control: { type: "ephemeral" } },
        functionCall,
        functionOutput,
        userMsg,
        assistantMsg,
      ],
    };
    const inputBefore = structuredClone(body.input);

    compress.mockResolvedValue({
      messages: [{ role: "assistant", content: "kept assistant reply" }],
    });

    const { compressWithHeadroom } = await import("../../open-sse/rtk/headroom.js");
    const result = await compressWithHeadroom(body, "gpt-4");

    expect(result?.saved).toBeGreaterThan(0);
    expect(body.input[0]).toEqual(inputBefore[0]);
    expect(body.input.some((item) => item.type === "function_call" && item.call_id === "call_1")).toBe(true);
    expect(body.input.some((item) => item.type === "function_call_output" && item.call_id === "call_1")).toBe(true);
    expect(body.input.filter((item) => item.type === "message" && item.role === "user")).toHaveLength(1);
    expect(body.input.at(-1)?.role).toBe("assistant");
  });

  it("applies in-place text compression when message count is unchanged", async () => {
    const longText = "verbose assistant reply ".repeat(80);
    const body = {
      input: [
        { type: "message", role: "user", content: "cached", cache_control: { type: "ephemeral" } },
        { type: "message", role: "user", content: [{ type: "input_text", text: "follow up" }] },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: longText }],
        },
      ],
    };

    compress.mockResolvedValue({
      messages: [
        { role: "user", content: "follow up" },
        { role: "assistant", content: "short" },
      ],
    });

    const { compressWithHeadroom } = await import("../../open-sse/rtk/headroom.js");
    const result = await compressWithHeadroom(body, "gpt-4");

    expect(result?.saved).toBeGreaterThan(0);
    expect(body.input).toHaveLength(3);
    expect(body.input.at(-1)?.content?.[0]?.text).toBe("short");
  });

  it("does not mutate body.messages when compression returns no savings", async () => {
    const body = {
      messages: [
        { role: "user", content: "cached", cache_control: { type: "ephemeral" } },
        { role: "user", content: "tail one" },
        { role: "assistant", content: "tail two" },
      ],
    };
    const snapshot = structuredClone(body.messages);

    compress.mockResolvedValue({
      messages: [
        { role: "user", content: "tail one" },
        { role: "assistant", content: "tail two" },
      ],
    });

    const { compressWithHeadroom } = await import("../../open-sse/rtk/headroom.js");
    const result = await compressWithHeadroom(body, "gpt-4");

    expect(result).toBeNull();
    expect(body.messages).toEqual(snapshot);
  });
});
