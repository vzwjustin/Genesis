/**
 * Cross-format cache_control guard in translateRequest.
 *
 * A Claude-format client (Claude Code) routed to a non-Claude upstream
 * (gpt-5.5 → openai-responses, gemini → antigravity) places Anthropic
 * cache_control breakpoints the upstream can never honor. The translator
 * must strip them and proceed, NOT reject the request. It still fails closed
 * when translating INTO Claude from a non-OpenAI source, where the markers
 * cannot be reconstructed on the rewritten body.
 */
import { describe, it, expect } from "vitest";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

function claudeBodyWithBreakpoint() {
  return {
    model: "claude-sonnet-4-5",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "hi", cache_control: { type: "ephemeral" } },
        ],
      },
    ],
    system: [
      { type: "text", text: "sys", cache_control: { type: "ephemeral" } },
    ],
  };
}

function hasCacheControl(obj) {
  return JSON.stringify(obj).includes("cache_control");
}

describe("translateRequest — cross-format cache_control", () => {
  it("strips breakpoints for claude → openai-responses (gpt-5.5 path)", () => {
    const out = translateRequest(
      FORMATS.CLAUDE,
      FORMATS.OPENAI_RESPONSES,
      "gpt-5.5",
      claudeBodyWithBreakpoint(),
    );
    expect(hasCacheControl(out)).toBe(false);
  });

  it("strips breakpoints for claude → antigravity (gemini path)", () => {
    const out = translateRequest(
      FORMATS.CLAUDE,
      FORMATS.ANTIGRAVITY,
      "gemini-3.5-flash",
      claudeBodyWithBreakpoint(),
    );
    expect(hasCacheControl(out)).toBe(false);
  });

  it("strips breakpoints for claude → openai (unchanged behavior)", () => {
    const out = translateRequest(
      FORMATS.CLAUDE,
      FORMATS.OPENAI,
      "gpt-4o",
      claudeBodyWithBreakpoint(),
    );
    expect(hasCacheControl(out)).toBe(false);
  });

  it("still fails closed for gemini → claude (markers unreconstructable)", () => {
    const geminiBody = {
      model: "claude-sonnet-4-5",
      contents: [
        { role: "user", parts: [{ text: "hi" }] },
      ],
      // Anthropic breakpoint placed by a non-OpenAI source body.
      messages: [
        { role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] },
      ],
    };
    expect(() =>
      translateRequest(FORMATS.GEMINI, FORMATS.CLAUDE, "claude-sonnet-4-5", geminiBody),
    ).toThrow(/cache_control breakpoints/);
  });
});
