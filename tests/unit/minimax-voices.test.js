/**
 * MiniMax voices API — source inspection (no DB/network mocks).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const root = dirname(fileURLToPath(import.meta.url));
const routePath = join(root, "../../src/app/api/media-providers/tts/minimax/voices/route.js");

describe("MiniMax voices API", () => {
  it("uses proxyAwareFetch with global and CN endpoints", () => {
    const src = readFileSync(routePath, "utf8");
    expect(src).toContain("proxyAwareFetch");
    expect(src).toContain("buildProxyOptionsFromCredentials");
    expect(src).toContain("https://api.minimax.io/v1/get_voice");
    expect(src).toContain("https://api.minimaxi.com/v1/get_voice");
    expect(src).not.toMatch(/\bfetch\s*\(/);
  });

  it("groups voices by language and supports minimax-cn provider query", () => {
    const src = readFileSync(routePath, "utf8");
    expect(src).toContain("inferLanguage");
    expect(src).toContain("byLang");
    expect(src).toContain("minimax-cn");
    expect(src).toContain("voice_type");
    expect(src).toContain('searchParams.get("voice_type")');
  });
});
