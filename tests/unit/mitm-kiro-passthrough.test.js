import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { kiroRequiresPassthrough } = require("../../src/mitm/handlers/kiro.js");

function body(conversationState) {
  return Buffer.from(JSON.stringify({ conversationState }));
}

describe("kiroRequiresPassthrough", () => {
  it("returns false for plain chat without tool activity", () => {
    const buf = body({
      currentMessage: {
        userInputMessage: {
          content: "hello",
          origin: "AI_EDITOR",
        },
      },
      history: [
        { userInputMessage: { content: "first", origin: "AI_EDITOR" } },
        { assistantResponseMessage: { content: "hi there" } },
      ],
    });
    expect(kiroRequiresPassthrough(buf)).toBe(false);
  });

  it("returns true when current turn submits toolResults", () => {
    const buf = body({
      currentMessage: {
        userInputMessage: {
          content: "",
          origin: "AI_EDITOR",
          userInputMessageContext: {
            toolResults: [{ toolUseId: "t1", content: [{ text: "file contents" }] }],
          },
        },
      },
      history: [
        { userInputMessage: { content: "read foo", origin: "AI_EDITOR" } },
        {
          assistantResponseMessage: {
            content: "",
            toolUses: [{ toolUseId: "t1", name: "read_file", input: '{"path":"foo"}' }],
          },
        },
      ],
    });
    expect(kiroRequiresPassthrough(buf)).toBe(true);
  });

  it("returns true when history contains assistant toolUses even if current turn has no toolResults", () => {
    const buf = body({
      currentMessage: {
        userInputMessage: {
          content: "continue after tools",
          origin: "AI_EDITOR",
        },
      },
      history: [
        { userInputMessage: { content: "first", origin: "AI_EDITOR" } },
        {
          assistantResponseMessage: {
            content: "",
            toolUses: [{ toolUseId: "t1", name: "list_dir", input: "{}" }],
          },
        },
        {
          userInputMessage: {
            content: "",
            userInputMessageContext: {
              toolResults: [{ toolUseId: "t1", content: [{ text: "ok" }] }],
            },
          },
        },
        { assistantResponseMessage: { content: "done" } },
      ],
    });
    expect(kiroRequiresPassthrough(buf)).toBe(true);
  });

  it("returns true when history contains prior toolResults", () => {
    const buf = body({
      currentMessage: {
        userInputMessage: {
          content: "next step",
          origin: "AI_EDITOR",
        },
      },
      history: [
        {
          userInputMessage: {
            content: "",
            userInputMessageContext: {
              toolResults: [{ toolUseId: "t2", content: [{ text: "result" }] }],
            },
          },
        },
        { assistantResponseMessage: { content: "thanks" } },
      ],
    });
    expect(kiroRequiresPassthrough(buf)).toBe(true);
  });

  it("returns false for invalid JSON", () => {
    expect(kiroRequiresPassthrough(Buffer.from("not json"))).toBe(false);
  });

  it("returns false when conversationState is missing", () => {
    expect(kiroRequiresPassthrough(Buffer.from(JSON.stringify({ model: "x" })))).toBe(false);
  });
});
