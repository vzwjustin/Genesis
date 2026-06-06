import { describe, it, expect } from "vitest";
import { parseModel, resolveProviderAlias } from "../../open-sse/services/model.js";

describe("parseModel — model string parsing", () => {
  describe("provider/model format (Format 1)", () => {
    it("parses provider/model with known provider alias", () => {
      const result = parseModel("cc/claude-opus-4-6");
      expect(result.provider).toBe("claude");
      expect(result.model).toBe("claude-opus-4-6");
      expect(result.isAlias).toBe(false);
      expect(result.providerAlias).toBe("cc");
      expect(result.original).toBe("cc/claude-opus-4-6");
    });

    it("parses provider/model with full provider name", () => {
      const result = parseModel("openai/gpt-4o");
      expect(result.provider).toBe("openai");
      expect(result.model).toBe("gpt-4o");
      expect(result.isAlias).toBe(false);
      expect(result.providerAlias).toBe("openai");
      expect(result.original).toBe("openai/gpt-4o");
    });

    it("resolves short alias to provider ID in provider/model format", () => {
      const result = parseModel("cx/o3-pro");
      expect(result.provider).toBe("codex");
      expect(result.model).toBe("o3-pro");
      expect(result.isAlias).toBe(false);
      expect(result.providerAlias).toBe("cx");
    });

    it("passes through unknown provider prefix as-is", () => {
      const result = parseModel("unknown-provider/some-model");
      // Unknown aliases pass through unchanged
      expect(result.provider).toBe("unknown-provider");
      expect(result.model).toBe("some-model");
      expect(result.isAlias).toBe(false);
    });

    it("handles model names with multiple slashes (only splits on first)", () => {
      const result = parseModel("openai/ft:gpt-4o:my-org/custom");
      expect(result.provider).toBe("openai");
      expect(result.model).toBe("ft:gpt-4o:my-org/custom");
      expect(result.isAlias).toBe(false);
    });
  });

  describe("plain string — alias or combo name (Format 2/3)", () => {
    it("returns isAlias=true for plain string (alias)", () => {
      const result = parseModel("opus");
      expect(result.provider).toBeNull();
      expect(result.model).toBe("opus");
      expect(result.isAlias).toBe(true);
      expect(result.providerAlias).toBeNull();
      expect(result.original).toBe("opus");
    });

    it("returns isAlias=true for plain string that could be a combo name", () => {
      const result = parseModel("primary-fallback");
      expect(result.provider).toBeNull();
      expect(result.model).toBe("primary-fallback");
      expect(result.isAlias).toBe(true);
      expect(result.providerAlias).toBeNull();
      expect(result.original).toBe("primary-fallback");
    });

    it("does not attempt to resolve plain strings as provider aliases", () => {
      // "cc" by itself is a model alias lookup, not provider resolution
      const result = parseModel("cc");
      expect(result.provider).toBeNull();
      expect(result.model).toBe("cc");
      expect(result.isAlias).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("handles null input", () => {
      const result = parseModel(null);
      expect(result.provider).toBeNull();
      expect(result.model).toBeNull();
      expect(result.isAlias).toBe(false);
      expect(result.original).toBe("");
    });

    it("handles undefined input", () => {
      const result = parseModel(undefined);
      expect(result.provider).toBeNull();
      expect(result.model).toBeNull();
      expect(result.isAlias).toBe(false);
      expect(result.original).toBe("");
    });

    it("handles empty string input", () => {
      const result = parseModel("");
      expect(result.provider).toBeNull();
      expect(result.model).toBeNull();
      expect(result.isAlias).toBe(false);
      expect(result.original).toBe("");
    });

    it("preserves original model string for logging/tracing", () => {
      const result = parseModel("gc/gemini-2.0-flash");
      expect(result.original).toBe("gc/gemini-2.0-flash");
    });
  });
});

describe("resolveProviderAlias", () => {
  it("resolves known short aliases", () => {
    expect(resolveProviderAlias("cc")).toBe("claude");
    expect(resolveProviderAlias("cx")).toBe("codex");
    expect(resolveProviderAlias("gc")).toBe("gemini-cli");
    expect(resolveProviderAlias("gh")).toBe("github");
    expect(resolveProviderAlias("kr")).toBe("kiro");
    expect(resolveProviderAlias("cu")).toBe("cursor");
  });

  it("resolves full provider names to themselves", () => {
    expect(resolveProviderAlias("openai")).toBe("openai");
    expect(resolveProviderAlias("anthropic")).toBe("anthropic");
    expect(resolveProviderAlias("gemini")).toBe("gemini");
  });

  it("passes through unknown aliases unchanged", () => {
    expect(resolveProviderAlias("unknown")).toBe("unknown");
    expect(resolveProviderAlias("my-custom-provider")).toBe("my-custom-provider");
  });
});
