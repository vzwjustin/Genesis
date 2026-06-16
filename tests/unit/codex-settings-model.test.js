import { describe, it, expect } from "vitest";
import {
  toCodexNativeModel,
  isCodexNativeModelId,
  resolveBareCodexModel,
} from "../../src/shared/utils/codexModel.js";

describe("toCodexNativeModel", () => {
  it("strips cx/ prefix for Codex config", () => {
    expect(toCodexNativeModel("cx/gpt-5.5")).toBe("gpt-5.5");
  });

  it("passes through native Codex model ids", () => {
    expect(toCodexNativeModel("gpt-5.5")).toBe("gpt-5.5");
    expect(toCodexNativeModel("gpt-5.3-codex-high")).toBe("gpt-5.3-codex-high");
  });

  it("strips codex/ prefix if present", () => {
    expect(toCodexNativeModel("codex/gpt-5.4")).toBe("gpt-5.4");
  });

  it("does not strip openrouter or cc routing prefixes", () => {
    expect(toCodexNativeModel("openrouter/anthropic/claude-3.5-sonnet")).toBe(
      "openrouter/anthropic/claude-3.5-sonnet",
    );
    expect(toCodexNativeModel("cc/claude-opus-4-6")).toBe("cc/claude-opus-4-6");
  });
});

describe("isCodexNativeModelId", () => {
  it("accepts bare codex ids", () => {
    expect(isCodexNativeModelId("gpt-5.5")).toBe(true);
  });

  it("rejects routing ids", () => {
    expect(isCodexNativeModelId("openrouter/foo")).toBe(false);
    expect(isCodexNativeModelId("cc/claude-opus")).toBe(false);
  });
});

describe("resolveBareCodexModel", () => {
  it("routes catalog Codex ids to cx/codex without a registered alias", () => {
    expect(resolveBareCodexModel("gpt-5.5")).toEqual({ provider: "codex", model: "gpt-5.5" });
    expect(resolveBareCodexModel("gpt-5.4")).toEqual({ provider: "codex", model: "gpt-5.4" });
  });

  it("does not guess unknown bare strings", () => {
    expect(resolveBareCodexModel("completely-unknown")).toBeNull();
    expect(resolveBareCodexModel("openai/gpt-4o")).toBeNull();
  });

  it("does not route bare image catalog ids to chat codex", () => {
    expect(resolveBareCodexModel("gpt-5.5-image")).toBeNull();
  });
});
