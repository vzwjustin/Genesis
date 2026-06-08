/**
 * Round 17 — TTS proxy migration, models/test hardening, combo resolution
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi, beforeEach } from "vitest";

const proxyAwareFetch = vi.hoisted(() => vi.fn());
const ttsFetch = vi.hoisted(() => vi.fn());

vi.mock("open-sse/utils/proxyFetch.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    proxyAwareFetch: (...args) => proxyAwareFetch(...args),
  };
});

describe("TTS providers proxy migration", () => {
  const ttsRoot = join(dirname(fileURLToPath(import.meta.url)), "../../open-sse/handlers/ttsProviders");

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

  it("synthesizeViaConfig passes proxyOptions to format handlers", async () => {
    const src = readFileSync(join(ttsRoot, "index.js"), "utf8");
    expect(src).toContain("buildProxyOptionsFromCredentials");
    expect(src).toContain("proxyOptions");
  });
});

describe("TTS voice routes proxy migration", () => {
  const apiRoot = join(dirname(fileURLToPath(import.meta.url)), "../../src/app/api/media-providers/tts");

  it("deepgram, inworld, and minimax voice routes use proxyAwareFetch", () => {
    for (const route of ["deepgram/voices/route.js", "inworld/voices/route.js", "minimax/voices/route.js"]) {
      const src = readFileSync(join(apiRoot, route), "utf8");
      expect(src).toContain("proxyAwareFetch");
      expect(src).not.toMatch(/\bfetch\s*\(/);
    }
  });
});

describe("broken combo resolution error", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("getBrokenComboError returns message when combo exists but has no valid models", async () => {
    vi.doMock("@/lib/localDb", () => ({
      getModelAliases: vi.fn(),
      getComboByName: vi.fn().mockResolvedValue({ name: "empty-combo", models: ["", "  "] }),
      getProviderNodes: vi.fn(),
    }));

    const { getBrokenComboError } = await import("../../src/sse/services/model.js");
    const error = await getBrokenComboError("empty-combo");
    expect(error).toBe('Combo "empty-combo" has no valid model targets configured.');

    vi.doUnmock("@/lib/localDb");
  });

  it("getBrokenComboError returns null for unknown model names", async () => {
    vi.doMock("@/lib/localDb", () => ({
      getModelAliases: vi.fn(),
      getComboByName: vi.fn().mockResolvedValue(null),
      getProviderNodes: vi.fn(),
    }));

    const { getBrokenComboError } = await import("../../src/sse/services/model.js");
    expect(await getBrokenComboError("not-a-combo")).toBeNull();

    vi.doUnmock("@/lib/localDb");
  });
});

describe("models/test hardening", () => {
  it("fails closed on empty or invalid JSON via internalApiPost", () => {
    const routeSrc = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../src/app/api/models/test/route.js"),
      "utf8"
    );
    const apiSrc = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../src/lib/internalApi.js"),
      "utf8"
    );
    expect(routeSrc).toContain("internalApiPost");
    expect(routeSrc).toContain("parseError");
    expect(apiSrc).toContain("Empty response body");
    expect(apiSrc).toContain("Invalid JSON response");
  });
});
