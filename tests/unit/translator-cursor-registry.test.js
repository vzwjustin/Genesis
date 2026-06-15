import { describe, it, expect } from "vitest";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

describe("translator registry — openai to cursor", () => {
  it("registers openai:cursor in the same registry translateRequest uses", () => {
    const result = translateRequest(
      FORMATS.OPENAI,
      FORMATS.CURSOR,
      "composer-2.5",
      { model: "composer-2.5", messages: [{ role: "user", content: "hi" }] },
    );
    expect(result.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(result.max_tokens).toBe(32000);
  });
});
