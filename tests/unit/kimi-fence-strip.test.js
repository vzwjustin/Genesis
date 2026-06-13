/**
 * #4 — ```json fence stripping must be gated to Kimi only.
 * Kimi wraps JSON answers in ```json...``` fences that need stripping, but the
 * strip previously ran for every Claude-format provider, corrupting a normal
 * Claude answer that legitimately returns a fenced code block.
 */
import { describe, it, expect } from "vitest";
import { translateNonStreamingResponse } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

function claudeBody(model, text) {
  return {
    id: "msg_1",
    model,
    stop_reason: "end_turn",
    content: [{ type: "text", text }],
  };
}

describe("kimi fence strip gating", () => {
  it("strips ```json fences for kimi models", () => {
    const out = translateNonStreamingResponse(
      claudeBody("kimi-k2", "```json\n{\"a\":1}\n```"),
      FORMATS.CLAUDE,
      FORMATS.OPENAI
    );
    expect(out.choices[0].message.content).toBe("{\"a\":1}");
  });

  it("preserves fenced code blocks for non-kimi Claude models", () => {
    const fenced = "```json\n{\"a\":1}\n```";
    const out = translateNonStreamingResponse(
      claudeBody("claude-opus-4-8", fenced),
      FORMATS.CLAUDE,
      FORMATS.OPENAI
    );
    // A legitimate Claude fenced block must survive untouched.
    expect(out.choices[0].message.content).toBe(fenced);
  });
});
