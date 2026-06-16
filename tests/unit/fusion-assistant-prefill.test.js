import { describe, it, expect } from "vitest";
import { stripTrailingAssistantPrefill } from "../../open-sse/translator/helpers/openaiHelper.js";

describe("stripTrailingAssistantPrefill", () => {
  it("removes a trailing assistant prefill turn", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Partial " },
    ];
    expect(stripTrailingAssistantPrefill(messages)).toEqual([
      { role: "user", content: "Hello" },
    ]);
  });

  it("removes multiple consecutive trailing assistant turns", () => {
    const messages = [
      { role: "user", content: "Go" },
      { role: "assistant", content: "a" },
      { role: "assistant", content: "b" },
    ];
    expect(stripTrailingAssistantPrefill(messages)).toEqual([
      { role: "user", content: "Go" },
    ]);
  });

  it("keeps trailing assistant when it has tool_calls", () => {
    const messages = [
      { role: "user", content: "Run tool" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "x", arguments: "{}" } }],
      },
    ];
    expect(stripTrailingAssistantPrefill(messages)).toEqual(messages);
  });

  it("is a no-op when the conversation already ends on user", () => {
    const messages = [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
      { role: "user", content: "Again" },
    ];
    expect(stripTrailingAssistantPrefill(messages)).toEqual(messages);
  });

  it("can strip all messages when the thread is only assistant prefill", () => {
    const messages = [
      { role: "assistant", content: "only prefill" },
    ];
    expect(stripTrailingAssistantPrefill(messages)).toEqual([]);
  });
});
