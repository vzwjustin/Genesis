import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { __test__ } = require("../../src/mitm/handlers/kiro.js");
const { convertUserInputMessage } = __test__;

describe("Kiro convertUserInputMessage tool results", () => {
  it("serializes json content blocks in tool results", () => {
    const messages = convertUserInputMessage({
      content: "",
      userInputMessageContext: {
        toolResults: [{
          toolUseId: "t-json",
          content: [{ json: { files: ["a.js", "b.js"], count: 2 } }],
        }],
      },
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("tool");
    expect(messages[0].tool_call_id).toBe("t-json");
    expect(JSON.parse(messages[0].content)).toEqual({ files: ["a.js", "b.js"], count: 2 });
  });

  it("joins text and json blocks in one tool result", () => {
    const messages = convertUserInputMessage({
      content: "follow-up",
      userInputMessageContext: {
        toolResults: [{
          toolUseId: "t-mix",
          content: [
            { text: "stdout line" },
            { json: { exitCode: 0 } },
          ],
        }],
      },
    });

    expect(messages[0].content).toBe('stdout line\n{"exitCode":0}');
    expect(messages[1]).toEqual({ role: "user", content: "follow-up" });
  });
});
