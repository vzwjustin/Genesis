import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");

describe("PR #72 Kilo follow-up", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("headroom preserves input_text when applying compressed Responses input", async () => {
    const compress = vi.fn(async () => ({
      messages: [{ role: "user", content: [{ type: "input_text", input_text: "smaller tail" }] }],
    }));
    vi.doMock("headroom-ai", () => ({ compress }));
    globalThis.fetch = vi.fn(async () => ({ ok: true }));

    const { compressWithHeadroom } = await import("../../open-sse/rtk/headroom.js");
    const body = {
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", input_text: "cached prefix" }],
          cache_control: { type: "ephemeral" },
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", input_text: "x".repeat(2000) }],
        },
      ],
    };

    const result = await compressWithHeadroom(body, "gpt-4");
    expect(result).not.toBeNull();
    expect(body.input[1].content[0].input_text).toBe("smaller tail");
  });

  it("sseToJsonHandler drops redundant sawTerminal guard", () => {
    const src = readFileSync(join(root, "open-sse/handlers/chatCore/sseToJsonHandler.js"), "utf8");
    expect(src).not.toMatch(/!sawTerminal && !mergedCandidate\.finishReason/);
  });

  it("README links upstream compare to decolua/9router", () => {
    const src = readFileSync(join(root, "README.md"), "utf8");
    expect(src).toContain("github.com/decolua/9router/compare/master...vzwjustin:master");
    expect(src).not.toContain(".kiro/specs/` (planning notes)");
  });
});
