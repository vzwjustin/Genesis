import { describe, it, expect } from "vitest";

import { getComboModelsFromData, isValidComboModelTarget } from "../../open-sse/services/combo.js";

describe("combo expansion into ordered provider/model list", () => {
  describe("isValidComboModelTarget", () => {
    it("accepts provider/model format strings", () => {
      expect(isValidComboModelTarget("cc/claude-opus-4-6")).toBe(true);
      expect(isValidComboModelTarget("openai/gpt-4o")).toBe(true);
    });

    it("accepts plain alias strings", () => {
      expect(isValidComboModelTarget("opus")).toBe(true);
      expect(isValidComboModelTarget("gpt-4o")).toBe(true);
    });

    it("rejects empty strings", () => {
      expect(isValidComboModelTarget("")).toBe(false);
      expect(isValidComboModelTarget("   ")).toBe(false);
    });

    it("rejects non-string values", () => {
      expect(isValidComboModelTarget(null)).toBe(false);
      expect(isValidComboModelTarget(undefined)).toBe(false);
      expect(isValidComboModelTarget(123)).toBe(false);
      expect(isValidComboModelTarget({})).toBe(false);
      expect(isValidComboModelTarget([])).toBe(false);
    });
  });

  describe("getComboModelsFromData", () => {
    const combosData = [
      { name: "primary-fallback", models: ["cc/claude-opus-4-6", "openai/gpt-4o"] },
      { name: "empty-combo", models: [] },
      { name: "invalid-models", models: ["", "   ", null, undefined, 123] },
      { name: "mixed-combo", models: ["cc/opus", "", "openai/gpt-4o", null] },
      { name: "single-valid", models: ["", "openai/gpt-4o", ""] },
      { name: "no-models-field" },
    ];

    it("expands combo name into ordered list of provider/model strings", () => {
      const result = getComboModelsFromData("primary-fallback", combosData);
      expect(result).toEqual(["cc/claude-opus-4-6", "openai/gpt-4o"]);
    });

    it("preserves order of models in combo", () => {
      const orderedCombos = [
        { name: "ordered", models: ["openai/gpt-4o", "cc/opus", "gemini/pro"] }
      ];
      const result = getComboModelsFromData("ordered", orderedCombos);
      expect(result).toEqual(["openai/gpt-4o", "cc/opus", "gemini/pro"]);
    });

    it("returns null for combo with empty models array (no valid targets)", () => {
      const result = getComboModelsFromData("empty-combo", combosData);
      expect(result).toBeNull();
    });

    it("returns null for combo with all invalid model entries", () => {
      const result = getComboModelsFromData("invalid-models", combosData);
      expect(result).toBeNull();
    });

    it("filters out invalid entries and returns only valid targets", () => {
      const result = getComboModelsFromData("mixed-combo", combosData);
      expect(result).toEqual(["cc/opus", "openai/gpt-4o"]);
    });

    it("returns a single valid model when only one remains after filtering", () => {
      const result = getComboModelsFromData("single-valid", combosData);
      expect(result).toEqual(["openai/gpt-4o"]);
    });

    it("returns null when combo has no models field", () => {
      const result = getComboModelsFromData("no-models-field", combosData);
      expect(result).toBeNull();
    });

    it("returns null for non-existent combo name", () => {
      const result = getComboModelsFromData("nonexistent", combosData);
      expect(result).toBeNull();
    });

    it("returns null for provider/model format input (not a combo lookup)", () => {
      const result = getComboModelsFromData("cc/opus", combosData);
      expect(result).toBeNull();
    });

    it("handles combosData in object format with combos property", () => {
      const objectData = { combos: combosData };
      const result = getComboModelsFromData("primary-fallback", objectData);
      expect(result).toEqual(["cc/claude-opus-4-6", "openai/gpt-4o"]);
    });

    it("combo name match with no valid actionable targets does NOT count as success", () => {
      // Per AGENTS.md: "A Model_String matching a registered combo name is not enough
      // to count as successful resolution."
      // The combo "invalid-models" exists but has no valid targets → returns null
      const result = getComboModelsFromData("invalid-models", combosData);
      expect(result).toBeNull();
    });
  });
});
