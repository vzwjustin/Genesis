import { describe, it, expect } from "vitest";
import { toCodexNativeModel } from "../../src/shared/utils/codexModel.js";

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
});
