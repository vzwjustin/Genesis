/**
 * Unit tests for model resolution failure returning HTTP 400.
 *
 * Requirement 2.4: IF Model_String resolution ultimately fails to produce a valid provider
 * and model (after checking all resolution methods), THEN THE Proxy SHALL return HTTP 400
 * with a descriptive error message.
 *
 * AGENTS.md:
 * - A Model_String matching a registered combo name is not enough to count as successful resolution.
 * - If combo resolution ultimately fails: return an error, do not silently fall back,
 *   do not treat the combo-name match as success.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @/lib/localDb before importing the module under test
vi.mock("@/lib/localDb", () => ({
  getModelAliases: vi.fn(),
  getComboByName: vi.fn(),
  getProviderNodes: vi.fn(),
}));

import { getModelInfo, getComboModels } from "../../src/sse/services/model.js";
import { getModelAliases, getComboByName, getProviderNodes } from "@/lib/localDb";

beforeEach(() => {
  vi.clearAllMocks();
  // Default: empty registries
  getModelAliases.mockResolvedValue({});
  getComboByName.mockResolvedValue(null);
  getProviderNodes.mockResolvedValue([]);
});

describe("getModelInfo — resolution failure returns null provider (Requirement 2.4)", () => {
  describe("unresolvable plain strings", () => {
    it("returns null provider for a model string that is not an alias, combo, or provider/model format", async () => {
      getModelAliases.mockResolvedValue({ opus: "cc/claude-opus-4-6" });
      getComboByName.mockResolvedValue(null);

      const result = await getModelInfo("nonexistent-garbage-model");
      expect(result.provider).toBeNull();
      expect(result.model).toBe("nonexistent-garbage-model");
    });

    it("does NOT silently infer 'openai' as provider for unknown model strings", async () => {
      getModelAliases.mockResolvedValue({});
      getComboByName.mockResolvedValue(null);

      const result = await getModelInfo("completely-unknown");
      // Previously this would return { provider: "openai" } via inferProviderFromModelName
      expect(result.provider).toBeNull();
    });

    it("does NOT silently infer 'anthropic' for claude-like model names that are not registered", async () => {
      // Even though "claude-fake-model" starts with "claude-", if it's not a registered alias,
      // we should not silently guess. The requirement says resolution must succeed via
      // registered methods (alias registry, combo, or explicit provider/model format).
      getModelAliases.mockResolvedValue({});
      getComboByName.mockResolvedValue(null);

      const result = await getModelInfo("claude-fake-model");
      expect(result.provider).toBeNull();
    });

    it("returns null provider when aliases registry is empty", async () => {
      getModelAliases.mockResolvedValue({});
      getComboByName.mockResolvedValue(null);

      const result = await getModelInfo("some-model");
      expect(result.provider).toBeNull();
    });
  });

  describe("successful resolution still works", () => {
    it("resolves provider/model format directly (no alias lookup needed)", async () => {
      const result = await getModelInfo("openai/gpt-4o");
      expect(result.provider).toBe("openai");
      expect(result.model).toBe("gpt-4o");
    });

    it("resolves registered alias to provider/model", async () => {
      getModelAliases.mockResolvedValue({ opus: "cc/claude-opus-4-6" });
      getComboByName.mockResolvedValue(null);

      const result = await getModelInfo("opus");
      expect(result.provider).toBe("claude");
      expect(result.model).toBe("claude-opus-4-6");
    });

    it("returns null provider for combo names (signals combo handling)", async () => {
      getComboByName.mockResolvedValue({ name: "primary-fallback", models: ["cc/opus", "openai/gpt-4o"] });

      const result = await getModelInfo("primary-fallback");
      expect(result.provider).toBeNull();
      expect(result.model).toBe("primary-fallback");
    });

    it("resolves provider alias prefix (cc → claude) in provider/model format", async () => {
      const result = await getModelInfo("cc/claude-opus-4-6");
      expect(result.provider).toBe("claude");
      expect(result.model).toBe("claude-opus-4-6");
    });

    it("returns null provider for unknown provider/model prefixes", async () => {
      const result = await getModelInfo("totally-unknown-provider/some-model");
      expect(result.provider).toBeNull();
      expect(result.model).toBe("totally-unknown-provider/some-model");
    });

    it("resolves slash combo names before provider/model parsing", async () => {
      getComboByName.mockResolvedValue({
        name: "cc/fallback",
        models: ["cc/opus"],
      });
      const result = await getModelInfo("cc/fallback");
      expect(result.provider).toBeNull();
      expect(result.model).toBe("cc/fallback");
    });
  });
});

describe("getComboModels — combo match requires valid actionable targets (AGENTS.md)", () => {
  it("returns null when provider/model string is not a registered combo name", async () => {
    getComboByName.mockResolvedValue(null);
    const result = await getComboModels("cc/claude-opus-4-6");
    expect(result).toBeNull();
    expect(getComboByName).toHaveBeenCalledWith("cc/claude-opus-4-6");
  });

  it("resolves combo names that contain slashes", async () => {
    getComboByName.mockResolvedValue({
      name: "cc/fallback",
      models: ["cc/opus", "openai/gpt-4o"],
    });
    const result = await getComboModels("cc/fallback");
    expect(result).toEqual(["cc/opus", "openai/gpt-4o"]);
  });

  it("returns model list when combo has valid models", async () => {
    getComboByName.mockResolvedValue({
      name: "primary",
      models: ["cc/opus", "openai/gpt-4o"],
    });

    const result = await getComboModels("primary");
    expect(result).toEqual(["cc/opus", "openai/gpt-4o"]);
  });

  it("returns null when combo name is registered but models array is empty", async () => {
    // A combo-name match alone is NOT enough to count as successful resolution
    getComboByName.mockResolvedValue({
      name: "empty-combo",
      models: [],
    });

    const result = await getComboModels("empty-combo");
    expect(result).toBeNull();
  });

  it("returns null when combo exists but models contains only empty strings", async () => {
    getComboByName.mockResolvedValue({
      name: "broken-combo",
      models: ["", "  ", ""],
    });

    const result = await getComboModels("broken-combo");
    expect(result).toBeNull();
  });

  it("filters out invalid (empty/whitespace) model entries from combo", async () => {
    getComboByName.mockResolvedValue({
      name: "partial-combo",
      models: ["cc/opus", "", "openai/gpt-4o", "  "],
    });

    const result = await getComboModels("partial-combo");
    expect(result).toEqual(["cc/opus", "openai/gpt-4o"]);
  });

  it("returns null when combo is not found in registry", async () => {
    getComboByName.mockResolvedValue(null);

    const result = await getComboModels("nonexistent-combo");
    expect(result).toBeNull();
  });

  it("returns null when combo has null models", async () => {
    getComboByName.mockResolvedValue({
      name: "null-models",
      models: null,
    });

    const result = await getComboModels("null-models");
    expect(result).toBeNull();
  });
});
