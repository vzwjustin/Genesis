import { describe, it, expect } from "vitest";
import { maskApiKeyForDisplay } from "../../src/shared/utils/apiKey.js";

describe("maskApiKeyForDisplay", () => {
  it("masks long keys with prefix and suffix", () => {
    const masked = maskApiKeyForDisplay("sk-machineid-abc123-crc8abcd");
    expect(masked.startsWith("sk-machineid")).toBe(true);
    expect(masked).toContain("…");
    expect(masked.endsWith("abcd")).toBe(true);
  });

  it("masks short keys conservatively", () => {
    expect(maskApiKeyForDisplay("sk-short")).toBe("sk-s…");
  });

  it("masks localhost sentinel without revealing full value", () => {
    expect(maskApiKeyForDisplay("sk_9router")).toBe("sk_9…");
    expect(maskApiKeyForDisplay("sk_9router")).not.toBe("sk_9router");
  });
});
