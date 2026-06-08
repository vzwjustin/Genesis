/**
 * Round 9 bug-hunt regression tests
 * No mocks: pure helpers, real combo/stream probes, source inspection.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { unavailableResponse } from "../../open-sse/utils/error.js";
import { handleComboChat, isModelResolutionFailureResponse } from "../../open-sse/services/combo.js";
import { exhaustedAccountsResponse } from "../../src/sse/utils/providerCredentialRetry.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const root = dirname(fileURLToPath(import.meta.url));
const noopLog = { info() {}, warn() {}, error() {} };

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

describe("unavailableResponse CORS", () => {
  it("includes Access-Control-Allow-Origin for browser clients", () => {
    const future = new Date(Date.now() + 5000).toISOString();
    const response = unavailableResponse(503, "Rate limited", future, "reset after 5s");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Retry-After")).toBeTruthy();
  });
});

describe("exhaustedAccountsResponse retry guidance", () => {
  it("returns Retry-After >= 1 when all accounts are exhausted", () => {
    const response = exhaustedAccountsResponse(true, 503, "All accounts unavailable");
    const retryAfter = parseInt(response.headers.get("Retry-After"), 10);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
  });
});

describe("combo Invalid model format advancement", () => {
  it("detects Invalid model format as resolution failure", async () => {
    const response = new Response(JSON.stringify({ error: { message: "Invalid model format" } }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
    expect(await isModelResolutionFailureResponse(response)).toBe(true);
  });

  it("advances past image/TTS-style Invalid model format combo member", async () => {
    const resolutionError = new Response(JSON.stringify({ error: { message: "Invalid model format" } }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
    const success = new Response(JSON.stringify({ data: [{ url: "http://example.com/x.png" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

    let calls = 0;
    const handleSingleModel = async () => {
      calls += 1;
      return calls === 1 ? resolutionError : success;
    };

    const response = await handleComboChat({
      body: { prompt: "a cat" },
      models: ["bad-image-model", "openai/dall-e"],
      handleSingleModel,
      log: noopLog,
    });

    expect(calls).toBe(2);
    expect(response.status).toBe(200);
  });
});

describe("passthrough SSE [DONE] sentinel", () => {
  it("appends [DONE] only for OpenAI chat-completions source format", async () => {
    const { createPassthroughStreamWithLogger } = await import("../../open-sse/utils/stream.js");
    const chunk = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n';

    const openaiOut = await drainPassthroughStream(
      createPassthroughStreamWithLogger("openai", null, "gpt-4", "c1", null, null, null, FORMATS.OPENAI),
      chunk
    );
    expect(openaiOut).toContain("data: [DONE]\n\n");

    const claudeOut = await drainPassthroughStream(
      createPassthroughStreamWithLogger("claude", null, "claude-sonnet", "c1", null, null, null, FORMATS.CLAUDE),
      chunk
    );
    expect(claudeOut).not.toContain("data: [DONE]\n\n");
  });
});

describe("embeddingsCore proxy routing (source)", () => {
  it("routes upstream embeddings through proxyAwareFetch with connection proxy options", () => {
    const src = readFileSync(join(root, "../../open-sse/handlers/embeddingsCore.js"), "utf8");
    expect(src).toContain("proxyAwareFetch");
    expect(src).toContain("buildProxyOptionsFromCredentials");
    expect(src).not.toMatch(/\bfetch\s*\(/);
  });
});
