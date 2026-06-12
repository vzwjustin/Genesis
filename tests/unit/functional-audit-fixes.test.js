/**
 * Regression tests for functional-audit-11 fixes — data-loss / mistranslation bugs.
 */
import { describe, it, expect } from "vitest";
import { convertKiroToOpenAI } from "../../open-sse/translator/response/kiro-to-openai.js";
import { geminiToOpenAIRequest } from "../../open-sse/translator/request/gemini-to-openai.js";

describe("kiro-to-openai: parallel tool calls keep distinct indices", () => {
  it("assigns incrementing tool_call index per toolUseEvent", () => {
    const state = {};
    const first = convertKiroToOpenAI(
      { toolUseEvent: { toolUseId: "t1", name: "get_weather", input: { city: "NYC" } } },
      state
    );
    const second = convertKiroToOpenAI(
      { toolUseEvent: { toolUseId: "t2", name: "get_time", input: { tz: "EST" } } },
      state
    );

    const idx1 = first.choices[0].delta.tool_calls[0].index;
    const idx2 = second.choices[0].delta.tool_calls[0].index;
    // Two separate calls must not collapse onto index 0 (which concatenated
    // their arguments into invalid JSON).
    expect(idx1).toBe(0);
    expect(idx2).toBe(1);
  });
});

describe("gemini-to-openai request: multiple functionResponse parts preserved", () => {
  it("emits one tool message per functionResponse, not just the first", () => {
    const body = {
      contents: [
        {
          role: "user",
          parts: [
            { functionResponse: { id: "c1", name: "a", response: { result: { ok: 1 } } } },
            { functionResponse: { id: "c2", name: "b", response: { result: { ok: 2 } } } },
          ],
        },
      ],
    };

    const out = geminiToOpenAIRequest("gemini-2.0-flash", body, false);
    const toolMsgs = out.messages.filter((m) => m.role === "tool");
    // Pre-fix: early return dropped the second functionResponse → only 1.
    expect(toolMsgs.length).toBe(2);
    expect(toolMsgs.map((m) => m.tool_call_id).sort()).toEqual(["c1", "c2"]);
  });
});
