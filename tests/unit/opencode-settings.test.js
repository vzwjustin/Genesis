import { describe, it, expect } from "vitest";
import {
  listGenesisModelIds,
  parseGenesisPrefixedModel,
} from "../../src/app/api/cli-tools/opencode-settings/route.js";

describe("opencode-settings genesis provider helpers", () => {
  it("lists models from both genesis and genesis-cc providers", () => {
    const config = {
      provider: {
        genesis: { models: { "openai/gpt-4o": { name: "openai/gpt-4o" } } },
        "genesis-cc": { models: { "cc/claude-opus-4-6": { name: "cc/claude-opus-4-6" } } },
      },
    };
    expect(listGenesisModelIds(config).sort()).toEqual(["cc/claude-opus-4-6", "openai/gpt-4o"]);
  });

  it("parses active model ids from genesis-cc prefix", () => {
    expect(parseGenesisPrefixedModel("genesis-cc/cc/claude-opus-4-6")).toBe("cc/claude-opus-4-6");
  });

  it("parses active model ids from genesis prefix", () => {
    expect(parseGenesisPrefixedModel("genesis/openai/gpt-4o")).toBe("openai/gpt-4o");
  });
});
