import { describe, it, expect } from "vitest";
import { parseModel, resolveModelAliasFromMap, getModelInfoCore } from "../../open-sse/services/model.js";

/**
 * Integration test: verifies that when a Model_String does not contain `/`,
 * the proxy looks up the string in the model alias registry and resolves it
 * to a `provider/model` pair (Requirement 2.2).
 *
 * This exercises the full pipeline: parseModel → getModelInfoCore → resolveModelAliasFromMap
 */
describe("getModelInfoCore — alias registry lookup integration (Requirement 2.2)", () => {
  describe("plain string triggers alias lookup", () => {
    it("resolves plain alias string via registry to provider/model", async () => {
      const aliases = { opus: "cc/claude-opus-4-6" };
      const result = await getModelInfoCore("opus", aliases);
      expect(result).toEqual({ provider: "claude", model: "claude-opus-4-6" });
    });

    it("resolves alias with object-format registry entry", async () => {
      const aliases = { flash: { provider: "gc", model: "gemini-2.0-flash" } };
      const result = await getModelInfoCore("flash", aliases);
      expect(result).toEqual({ provider: "gemini-cli", model: "gemini-2.0-flash" });
    });

    it("does NOT trigger alias lookup when model string contains /", async () => {
      const aliases = { "cc/claude-opus-4-6": "openai/gpt-4o" }; // should be ignored
      const result = await getModelInfoCore("cc/claude-opus-4-6", aliases);
      // Direct provider/model parsing, no alias lookup
      expect(result).toEqual({ provider: "claude", model: "claude-opus-4-6" });
    });

    it("returns null provider when alias not found (fail-closed)", async () => {
      const aliases = { opus: "cc/claude-opus-4-6" };
      const result = await getModelInfoCore("claude-sonnet-4-20250514", aliases);
      expect(result.provider).toBeNull();
      expect(result.model).toBe("claude-sonnet-4-20250514");
    });

    it("returns null provider when alias not found and prefix unrecognized", async () => {
      const aliases = {};
      const result = await getModelInfoCore("some-unknown-model", aliases);
      expect(result.provider).toBeNull();
      expect(result.model).toBe("some-unknown-model");
    });
  });

  describe("async alias getter function", () => {
    it("resolves alias using an async getter function", async () => {
      const aliasGetter = async () => ({ sonnet: "cc/claude-sonnet-4-20250514" });
      const result = await getModelInfoCore("sonnet", aliasGetter);
      expect(result).toEqual({ provider: "claude", model: "claude-sonnet-4-20250514" });
    });

    it("calls getter only when model is a plain string (isAlias)", async () => {
      let called = false;
      const aliasGetter = async () => { called = true; return {}; };
      // provider/model format should NOT call the getter
      await getModelInfoCore("openai/gpt-4o", aliasGetter);
      expect(called).toBe(false);
    });

    it("calls getter when model is a plain string", async () => {
      let called = false;
      const aliasGetter = async () => { called = true; return { test: "openai/gpt-4o" }; };
      await getModelInfoCore("test", aliasGetter);
      expect(called).toBe(true);
    });
  });

  describe("end-to-end: parseModel detects alias, getModelInfoCore resolves it", () => {
    it("plain string is detected as alias by parseModel", () => {
      const parsed = parseModel("opus");
      expect(parsed.isAlias).toBe(true);
      expect(parsed.provider).toBeNull();
      expect(parsed.model).toBe("opus");
    });

    it("alias is then resolved by getModelInfoCore via registry", async () => {
      const aliases = { opus: "anthropic/claude-opus-4-6" };
      // Step 1: parseModel detects it's an alias
      const parsed = parseModel("opus");
      expect(parsed.isAlias).toBe(true);
      // Step 2: getModelInfoCore resolves it
      const result = await getModelInfoCore("opus", aliases);
      expect(result.provider).toBe("anthropic");
      expect(result.model).toBe("claude-opus-4-6");
    });

    it("provider/model string is NOT treated as alias by parseModel", () => {
      const parsed = parseModel("cc/claude-opus-4-6");
      expect(parsed.isAlias).toBe(false);
      expect(parsed.provider).toBe("claude");
      expect(parsed.model).toBe("claude-opus-4-6");
    });
  });
});
