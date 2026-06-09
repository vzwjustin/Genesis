import { describe, it, expect } from "vitest";
import { resolveModelAliasFromMap } from "../../open-sse/services/model.js";

describe("resolveModelAliasFromMap — alias registry lookup (Requirement 2.2)", () => {
  describe("string format resolution ('alias' → 'provider/model')", () => {
    it("resolves alias to provider/model when value is a string with /", () => {
      const aliases = { opus: "cc/claude-opus-4-6" };
      const result = resolveModelAliasFromMap("opus", aliases);
      expect(result).toEqual({ provider: "claude", model: "claude-opus-4-6" });
    });

    it("resolves provider alias in the string format (cc → claude)", () => {
      const aliases = { sonnet: "cc/claude-sonnet-4-20250514" };
      const result = resolveModelAliasFromMap("sonnet", aliases);
      expect(result.provider).toBe("claude");
      expect(result.model).toBe("claude-sonnet-4-20250514");
    });

    it("resolves full provider name in string format", () => {
      const aliases = { "gpt4o": "openai/gpt-4o" };
      const result = resolveModelAliasFromMap("gpt4o", aliases);
      expect(result).toEqual({ provider: "openai", model: "gpt-4o" });
    });

    it("handles model names with multiple slashes (splits on first /)", () => {
      const aliases = { "ft-model": "openai/ft:gpt-4o:my-org/custom" };
      const result = resolveModelAliasFromMap("ft-model", aliases);
      expect(result.provider).toBe("openai");
      expect(result.model).toBe("ft:gpt-4o:my-org/custom");
    });
  });

  describe("object format resolution ({ provider, model })", () => {
    it("resolves alias when value is an object with provider and model", () => {
      const aliases = { opus: { provider: "cc", model: "claude-opus-4-6" } };
      const result = resolveModelAliasFromMap("opus", aliases);
      expect(result).toEqual({ provider: "claude", model: "claude-opus-4-6" });
    });

    it("resolves provider alias in object format", () => {
      const aliases = { flash: { provider: "gc", model: "gemini-2.0-flash" } };
      const result = resolveModelAliasFromMap("flash", aliases);
      expect(result.provider).toBe("gemini-cli");
      expect(result.model).toBe("gemini-2.0-flash");
    });

    it("resolves full provider name in object format", () => {
      const aliases = { deepthink: { provider: "deepseek", model: "deepseek-r1" } };
      const result = resolveModelAliasFromMap("deepthink", aliases);
      expect(result).toEqual({ provider: "deepseek", model: "deepseek-r1" });
    });
  });

  describe("missing alias returns null", () => {
    it("returns null when alias is not in the registry", () => {
      const aliases = { opus: "cc/claude-opus-4-6" };
      const result = resolveModelAliasFromMap("nonexistent", aliases);
      expect(result).toBeNull();
    });

    it("returns null when aliases object is null", () => {
      const result = resolveModelAliasFromMap("opus", null);
      expect(result).toBeNull();
    });

    it("returns null when aliases object is undefined", () => {
      const result = resolveModelAliasFromMap("opus", undefined);
      expect(result).toBeNull();
    });

    it("returns null when aliases object is empty", () => {
      const result = resolveModelAliasFromMap("opus", {});
      expect(result).toBeNull();
    });

    it("returns null when resolved value is a string without /", () => {
      // A string without "/" is not a valid provider/model format
      const aliases = { broken: "just-a-model-name" };
      const result = resolveModelAliasFromMap("broken", aliases);
      expect(result).toBeNull();
    });

    it("returns null when resolved value is an object missing provider", () => {
      const aliases = { broken: { model: "gpt-4o" } };
      const result = resolveModelAliasFromMap("broken", aliases);
      expect(result).toBeNull();
    });

    it("returns null when resolved value is an object missing model", () => {
      const aliases = { broken: { provider: "openai" } };
      const result = resolveModelAliasFromMap("broken", aliases);
      expect(result).toBeNull();
    });
  });

  describe("provider alias resolution via resolveProviderAlias", () => {
    it("resolves cc → claude in string format", () => {
      const aliases = { test: "cc/some-model" };
      const result = resolveModelAliasFromMap("test", aliases);
      expect(result.provider).toBe("claude");
    });

    it("resolves cx → codex in string format", () => {
      const aliases = { test: "cx/o3-pro" };
      const result = resolveModelAliasFromMap("test", aliases);
      expect(result.provider).toBe("codex");
    });

    it("resolves gc → gemini-cli in object format", () => {
      const aliases = { test: { provider: "gc", model: "gemini-2.5-pro" } };
      const result = resolveModelAliasFromMap("test", aliases);
      expect(result.provider).toBe("gemini-cli");
    });

    it("passes through unknown provider aliases unchanged", () => {
      const aliases = { test: "custom-provider/custom-model" };
      const result = resolveModelAliasFromMap("test", aliases);
      expect(result.provider).toBe("custom-provider");
      expect(result.model).toBe("custom-model");
    });
  });
});
