/**
 * Round 11 bug-hunt regression tests
 * No mocks: passthrough stream probes + source inspection.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { FORMATS } from "../../open-sse/translator/formats.js";

const root = dirname(fileURLToPath(import.meta.url));

async function drainPassthroughStream(transformStream, input) {
  const reader = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(input));
      controller.close();
    },
  }).pipeThrough(transformStream).getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

describe("passthrough stream byte-forward", () => {
  it("forwards usage-only chunks without dropping them", async () => {
    const { createPassthroughStreamWithLogger } = await import("../../open-sse/utils/stream.js");
    const usageChunk = JSON.stringify({
      id: "c1",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: null }],
      usage: { prompt_tokens: 10, completion_tokens: 0 },
    });
    const sse = `data: ${usageChunk}\n\n`;
    const out = await drainPassthroughStream(
      createPassthroughStreamWithLogger("openai", null, "gpt-4", "c1", null, null, null, FORMATS.OPENAI),
      sse
    );
    expect(out).toContain("prompt_tokens");
    expect(out).toContain("data: [DONE]\n\n");
  });

  it("does not inject object/created fields into passthrough chunks", async () => {
    const { createPassthroughStreamWithLogger } = await import("../../open-sse/utils/stream.js");
    const raw = JSON.stringify({ choices: [{ delta: { content: "hi" } }] });
    const sse = `data: ${raw}\n\n`;
    const out = await drainPassthroughStream(
      createPassthroughStreamWithLogger("openai", null, "gpt-4", "c1", null, null, null, FORMATS.OPENAI),
      sse
    );
    expect(out).not.toContain('"object":"chat.completion.chunk"');
    expect(out).toContain(raw);
  });
});

describe("Kiro passthrough response (source)", () => {
  it("returns native EventStream without SSE conversion when passthrough=true", () => {
    const src = readFileSync(join(root, "../../open-sse/executors/kiro.js"), "utf8");
    expect(src).toContain("if (passthrough)");
    expect(src).toContain("return { response, url, headers, transformedBody }");
    expect(src).toContain("transformEventStreamToSSE");
    expect(src).toContain("proxyAwareFetch");
  });
});

describe("STT proxy and Gemini auth (source)", () => {
  it("routes STT through sttFetch → proxyAwareFetch with buildProxyOptionsFromCredentials", () => {
    const src = readFileSync(join(root, "../../open-sse/handlers/sttCore.js"), "utf8");
    expect(src).toContain("proxyAwareFetch");
    expect(src).toContain("buildProxyOptionsFromCredentials");
    expect(src).toContain("function sttFetch");
  });

  it("Gemini STT uses x-goog-api-key header instead of query param", () => {
    const src = readFileSync(join(root, "../../open-sse/handlers/sttCore.js"), "utf8");
    const geminiBlock = src.slice(src.indexOf("async function transcribeGemini"));
    expect(geminiBlock).toContain('"x-goog-api-key": token');
    expect(geminiBlock).not.toMatch(/key=\$\{/);
  });
});
