/**
 * Headroom hard-skip tests (Task 12.1, 12.3)
 * Requirements: 8.2, 8.3
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("compressWithHeadroom hard skip before probing", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("skips when tail is empty (cache boundary is last message)", async () => {
    const { compressWithHeadroom } = await import("../../open-sse/rtk/headroom.js");
    const body = {
      messages: [
        { role: "user", content: "prefix" },
        { role: "assistant", content: "cached end", cache_control: { type: "ephemeral" } },
      ],
    };
    const result = await compressWithHeadroom(body, "gpt-4");
    expect(result).toBeNull();
  });

  it("skips when tail is system-only", async () => {
    const { compressWithHeadroom } = await import("../../open-sse/rtk/headroom.js");
    const body = {
      messages: [
        { role: "user", content: "hello", cache_control: { type: "ephemeral" } },
        { role: "system", content: "system-only tail" },
      ],
    };
    const result = await compressWithHeadroom(body, "gpt-4");
    expect(result).toBeNull();
  });

  it("attempts compression for a single post-cache message (Claude Code tool tail)", async () => {
    const compress = vi.fn(async (tail) => ({
      messages: [{ role: "user", content: "smaller" }],
    }));
    vi.doMock("headroom-ai", () => ({ compress }));

    globalThis.fetch = vi.fn(async () => ({ ok: true }));

    const { compressWithHeadroom } = await import("../../open-sse/rtk/headroom.js");
    const body = {
      messages: [
        { role: "user", content: "prefix" },
        { role: "assistant", content: "cached", cache_control: { type: "ephemeral" } },
        { role: "user", content: "x".repeat(2000) },
      ],
    };

    const result = await compressWithHeadroom(body, "claude-sonnet-4");
    expect(compress).toHaveBeenCalledOnce();
    expect(result?.saved).toBeGreaterThan(0);
    expect(body.messages).toHaveLength(3);
  });

  it("does not include cache-boundary messages in compressible tail", async () => {
    const { compressWithHeadroom } = await import("../../open-sse/rtk/headroom.js");
    const body = {
      messages: [
        { role: "user", content: "old" },
        { role: "assistant", content: "reply", cache_control: { type: "ephemeral" } },
        { role: "system", content: "system only after boundary" },
      ],
    };
    const result = await compressWithHeadroom(body, "gpt-4");
    expect(result).toBeNull();
  });
});

describe("injectCaveman stats gating (Task 13.4)", () => {
  it("returns false when body has no injectable surface", async () => {
    const { injectCaveman } = await import("../../open-sse/rtk/caveman.js");
    expect(injectCaveman({}, "openai", "full")).toBe(false);
    expect(injectCaveman({ model: "gpt-4" }, "openai", "full")).toBe(false);
  });

  it("returns true when injection succeeds on messages", async () => {
    const { injectCaveman } = await import("../../open-sse/rtk/caveman.js");
    const body = { messages: [{ role: "user", content: "hi" }] };
    expect(injectCaveman(body, "openai", "full")).toBe(true);
    expect(body.messages.some((m) => m.role === "system")).toBe(true);
  });

  it("appends Claude string system as a new block instead of mutating cached text", async () => {
    const { injectCaveman } = await import("../../open-sse/rtk/caveman.js");
    const body = { system: "cached system prompt" };
    expect(injectCaveman(body, "claude", "full")).toBe(true);
    expect(body.system).toEqual([
      { type: "text", text: "cached system prompt" },
      { type: "text", text: expect.stringContaining("caveman") },
    ]);
  });
});
