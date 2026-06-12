/**
 * Round 3+4 handler fixes: retry placement, account cleanup, nested combo, core MIME/Buffer.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const root = dirname(fileURLToPath(import.meta.url));
const handlersRoot = join(root, "../../src/sse/handlers");

function readHandler(name) {
  return readFileSync(join(handlersRoot, name), "utf8");
}

function retryLoopSlice(src) {
  const start = src.indexOf("while (true)");
  expect(start).toBeGreaterThan(-1);
  return src.slice(start);
}

function expectRetryAfterPreflight(handlerSrc, dispatchMarker) {
  const loop = retryLoopSlice(handlerSrc);
  const tokenRefreshIdx = loop.indexOf("_tokenRefreshFailed");
  const retryIncIdx = loop.indexOf("retryCount++");
  const dispatchIdx = loop.indexOf(dispatchMarker);
  expect(retryIncIdx).toBeGreaterThan(tokenRefreshIdx);
  expect(dispatchIdx).toBeGreaterThan(retryIncIdx);
  // retryCount++ must not appear before credentials lookup
  const credsIdx = loop.indexOf("getProviderCredentials");
  expect(retryIncIdx).toBeGreaterThan(credsIdx);
}

describe("handler retryCount placement (match chat.js)", () => {
  const cases = [
    ["tts.js", "handleTtsCore({"],
    ["stt.js", "handleSttCore({"],
    ["embeddings.js", "handleEmbeddingsCore({"],
    ["imageGeneration.js", "handleImageGenerationCore({"],
    ["search.js", "handleSearchCore({"],
    ["fetch.js", "handleFetchCore({"],
  ];

  for (const [file, marker] of cases) {
    it(`${file} increments retryCount after pre-flight checks`, () => {
      expectRetryAfterPreflight(readHandler(file), marker);
    });
  }
});

describe("tts.js + stt.js account lifecycle", () => {
  it("tts clears account error on success and passes proxy metadata to markAccountUnavailable", () => {
    const src = readHandler("tts.js");
    expect(src).toContain("clearAccountError");
    expect(src).toMatch(/if \(result\.success\)[\s\S]*clearAccountError/);
    expect(src).toContain("proxyInternal: result.proxyInternal");
    expect(src).toContain("errorCode: result.errorCode");
  });

  it("stt clears account error on success and passes proxy metadata to markAccountUnavailable", () => {
    const src = readHandler("stt.js");
    expect(src).toContain("clearAccountError");
    expect(src).toMatch(/if \(result\.success\)[\s\S]*clearAccountError/);
    expect(src).toContain("proxyInternal: result.proxyInternal");
    expect(src).toContain("errorCode: result.errorCode");
  });
});

describe("nested combo retry (match chat.js)", () => {
  it("tts handleSingleModelTts re-expands combo when provider is null", () => {
    const src = readHandler("tts.js");
    const fn = src.slice(src.indexOf("async function handleSingleModelTts"));
    expect(fn).toContain("getComboModels(modelStr)");
    expect(fn).toContain("handleComboChat({");
  });

  it("image handleSingleModelImage re-expands combo when provider is null", () => {
    const src = readHandler("imageGeneration.js");
    const fn = src.slice(src.indexOf("async function handleSingleModelImage"));
    expect(fn).toContain("getComboModels(modelStr)");
    expect(fn).toContain("handleComboChat({");
  });
});

describe("ttsCore MIME mapping", () => {
  it("maps mp3 to audio/mpeg in source", () => {
    const src = readFileSync(join(root, "../../open-sse/handlers/ttsCore.js"), "utf8");
    expect(src).toContain("resolveTtsContentType");
    expect(src).toContain('mp3: "audio/mpeg"');
    expect(src).toContain("resolveTtsContentType(format)");
  });

  it("returns audio/mpeg Content-Type for mp3 binary output", async () => {
    const { vi } = await import("vitest");
    vi.resetModules();
    vi.doMock("../../open-sse/handlers/ttsProviders/index.js", () => ({
      getTtsAdapter: () => ({
        synthesize: async () => ({
          base64: Buffer.from("fake-audio").toString("base64"),
          format: "mp3",
        }),
      }),
      synthesizeViaConfig: async () => null,
    }));

    const { handleTtsCore } = await import("../../open-sse/handlers/ttsCore.js");
    const result = await handleTtsCore({
      provider: "mock-tts",
      model: "voice",
      input: "hello",
      responseFormat: "mp3",
    });

    expect(result.success).toBe(true);
    expect(result.response.headers.get("Content-Type")).toBe("audio/mpeg");
    vi.doUnmock("../../open-sse/handlers/ttsProviders/index.js");
    vi.resetModules();
  });
});

describe("imageGenerationCore Buffer import", () => {
  it("imports Buffer from node:buffer", () => {
    const src = readFileSync(join(root, "../../open-sse/handlers/imageGenerationCore.js"), "utf8");
    expect(src).toMatch(/import\s+\{\s*Buffer\s*\}\s+from\s+["']node:buffer["']/);
    expect(src).toContain("Buffer.from(b64, \"base64\")");
  });
});

describe("sttCore AssemblyAI poll fail-fast", () => {
  it("fails after consecutive poll errors before job completes", () => {
    const src = readFileSync(join(root, "../../open-sse/handlers/sttCore.js"), "utf8");
    expect(src).toContain("MAX_CONSECUTIVE_POLL_ERRORS");
    expect(src).toContain("consecutivePollErrors");
    expect(src).toMatch(/consecutivePollErrors\s*>=\s*MAX_CONSECUTIVE_POLL_ERRORS/);
  });
});
