import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { maskApiKeyForDisplay } from "../../src/shared/utils/apiKey.js";

const root = join(import.meta.dirname, "..", "..");

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

  it("requires explicit reveal header before returning full stored keys", () => {
    const util = readFileSync(join(root, "src/shared/utils/revealApiKey.js"), "utf8");
    const route = readFileSync(join(root, "src/app/api/keys/[id]/route.js"), "utf8");

    expect(util).toContain('"x-9r-reveal-key": "1"');
    expect(route).toContain('request.headers.get("x-9r-reveal-key") !== "1"');
  });
});
