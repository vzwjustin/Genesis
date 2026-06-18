import { describe, it, expect } from "vitest";
import { maskApiKeyForDisplay } from "../../src/shared/utils/apiKey.js";

describe("maskApiKeyForDisplay", () => {
  it("masks long keys with prefix and suffix", () => {
    const masked = maskApiKeyForDisplay("sk-machineid-abc123-crc8abcd");
    expect(masked.startsWith("sk-mac")).toBe(true);
    expect(masked).toContain("•");
    expect(masked.endsWith("abcd")).toBe(true);
  });

  it("leaves short keys unmasked", () => {
    expect(maskApiKeyForDisplay("sk-short")).toBe("sk-short");
  });

  it("masks localhost sentinel without revealing full value", () => {
    expect(maskApiKeyForDisplay("sk_genesis")).toBe("sk_9…");
    expect(maskApiKeyForDisplay("sk_genesis")).not.toBe("sk_genesis");
  });
});
