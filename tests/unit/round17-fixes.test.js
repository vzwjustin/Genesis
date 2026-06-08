/**
 * Round 17 — TTS proxy migration, models/test hardening, combo resolution
 * No mocks: source inspection + pure combo helper tests.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { getBrokenComboErrorFromData } from "../../open-sse/services/combo.js";

const root = dirname(fileURLToPath(import.meta.url));

describe("TTS providers proxy migration", () => {
  const ttsRoot = join(root, "../../open-sse/handlers/ttsProviders");

  it("genericFormats and special adapters use ttsFetch instead of bare fetch", () => {
    const files = [
      "genericFormats.js",
      "elevenlabs.js",
      "openai.js",
      "gemini.js",
      "openrouter.js",
      "minimax.js",
      "edgeTts.js",
      "googleTts.js",
      "_base.js",
    ];
    for (const file of files) {
      const src = readFileSync(join(ttsRoot, file), "utf8");
      expect(src).toContain("ttsFetch");
      expect(src).not.toMatch(/\bfetch\s*\(/);
    }
  });

  it("synthesizeViaConfig passes proxyOptions to format handlers", () => {
    const src = readFileSync(join(ttsRoot, "index.js"), "utf8");
    expect(src).toContain("buildProxyOptionsFromCredentials");
    expect(src).toContain("proxyOptions");
  });
});

describe("TTS voice routes proxy migration", () => {
  const apiRoot = join(root, "../../src/app/api/media-providers/tts");

  it("deepgram, inworld, and minimax voice routes use proxyAwareFetch", () => {
    for (const route of ["deepgram/voices/route.js", "inworld/voices/route.js", "minimax/voices/route.js"]) {
      const src = readFileSync(join(apiRoot, route), "utf8");
      expect(src).toContain("proxyAwareFetch");
      expect(src).not.toMatch(/\bfetch\s*\(/);
    }
  });
});

describe("broken combo resolution error", () => {
  it("getBrokenComboErrorFromData returns message when combo has no valid models", () => {
    const combos = [{ name: "empty-combo", models: ["", "  "] }];
    expect(getBrokenComboErrorFromData("empty-combo", combos))
      .toBe('Combo "empty-combo" has no valid model targets configured.');
  });

  it("getBrokenComboErrorFromData returns null for unknown model names", () => {
    expect(getBrokenComboErrorFromData("not-a-combo", [])).toBeNull();
  });

  it("getBrokenComboErrorFromData returns null for provider/model strings", () => {
    expect(getBrokenComboErrorFromData("openai/gpt-4o", [{ name: "openai/gpt-4o", models: [] }])).toBeNull();
  });
});

describe("models/test hardening", () => {
  it("fails closed on empty or invalid JSON via internalApiPost", () => {
    const routeSrc = readFileSync(
      join(root, "../../src/app/api/models/test/route.js"),
      "utf8"
    );
    const apiSrc = readFileSync(join(root, "../../src/lib/internalApi.js"), "utf8");
    expect(routeSrc).toContain("internalApiPost");
    expect(routeSrc).toContain("parseError");
    expect(apiSrc).toContain("Empty response body");
    expect(apiSrc).toContain("Invalid JSON response");
  });
});
