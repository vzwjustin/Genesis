/**
 * Wave 2 — streaming flush, SSE assembly, proxy bypass, abort signal fixes
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestUsage: vi.fn(() => Promise.resolve()),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
}));

import { createPassthroughStreamWithLogger, createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";
import { convertResponsesStreamToJson } from "../../open-sse/transformer/streamToJsonConverter.js";
import { createResponsesApiTransformStream } from "../../open-sse/transformer/responsesTransformer.js";
import { mergeAbortSignals } from "../../open-sse/utils/abortSignal.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const root = join(import.meta.dirname, "..", "..");

function sseStream(text) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

async function collectStreamText(readable) {
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

async function pipeThroughTransform(providerSse, transformStream) {
  const input = sseStream(providerSse).pipeThrough(transformStream);
  return collectStreamText(input);
}

describe("stream.js — passthrough flush trailing buffer", () => {
  it("appends \\n\\n to trailing partial SSE frame on flush", async () => {
    const transform = createPassthroughStreamWithLogger("openai", null, "gpt-4");
    const out = await pipeThroughTransform('data: {"choices":[{"delta":{"content":"tail"}}]}', transform);
    expect(out).toMatch(/data: \{"choices":\[\{"delta":\{"content":"tail"\}\}\]\}\n\n$/);
  });
});

describe("stream.js — onPendingRelease error isolation", () => {
  it("does not prevent flush completion when onPendingRelease throws", async () => {
    const onPendingRelease = vi.fn(() => { throw new Error("release boom"); });
    const onStreamComplete = vi.fn();
    const transform = createPassthroughStreamWithLogger(
      "openai", null, "gpt-4", null, null, onStreamComplete, null, FORMATS.OPENAI, onPendingRelease
    );
    const out = await pipeThroughTransform(
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
      transform
    );
    expect(onPendingRelease).toHaveBeenCalled();
    expect(onStreamComplete).toHaveBeenCalled();
    expect(out).toContain("ok");
  });
});

describe("stream.js — translate flush passes targetFormat", () => {
  it("source passes targetFormat to parseSSELine in flush", () => {
    const src = readFileSync(join(root, "open-sse/utils/stream.js"), "utf8");
    expect(src).toMatch(/parseSSELine\(buffer\.trim\(\),\s*targetFormat\)/);
  });
});

describe("streamToJsonConverter — data-only Responses API blocks", () => {
  it("processes data-only response.completed events via inferred type", async () => {
    const sse = [
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_dataonly","created_at":1700000000}}',
      'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Hi"}]}}',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}',
    ].join("\n\n");

    const result = await convertResponsesStreamToJson(sseStream(sse));
    expect(result.status).toBe("completed");
    expect(result.output).toHaveLength(1);
    expect(result.usage.total_tokens).toBe(15);
  });
});

describe("responsesTransformer — sendCompleted includes usage", () => {
  it("emits usage in response.completed when upstream chunk carries usage", async () => {
    const sse = [
      'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}',
      'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":3,"total_tokens":15}}',
      "",
    ].join("\n\n");

    const transform = createResponsesApiTransformStream();
    const out = await pipeThroughTransform(sse, transform);
    expect(out).toContain("response.completed");
    const completedLine = out.split("\n").find((l) => l.startsWith("data:") && l.includes("response.completed"));
    expect(completedLine).toBeTruthy();
    const payload = JSON.parse(completedLine.slice(5).trim());
    expect(payload.response.usage).toEqual({
      input_tokens: 12,
      output_tokens: 3,
      total_tokens: 15,
    });
  });
});

describe("mergeAbortSignals — listener cleanup", () => {
  it("removes abort listeners after merged signal aborts", () => {
    if (typeof AbortSignal?.any === "function") {
      return; // native path does not use manual fan-in
    }

    const a = new AbortController();
    const b = new AbortController();
    const merged = mergeAbortSignals([a.signal, b.signal]);

    const abortReasons = [];
    merged.signal.addEventListener("abort", () => abortReasons.push(merged.signal.reason));

    a.abort("from-a");
    b.abort("from-b");

    expect(merged.signal.aborted).toBe(true);
    expect(abortReasons).toEqual(["from-a"]);
  });
});

describe("connectionProxy — supported schemes", () => {
  it("only allows http/https proxy schemes", () => {
    const src = readFileSync(join(root, "src/lib/network/connectionProxy.js"), "utf8");
    expect(src).toContain('new Set(["http:", "https:"])');
    expect(src).not.toContain("socks5:");
    expect(src).not.toContain("socks4:");
  });
});

describe("proxyFetch — wave2 hardening", () => {
  it("MITM bypass+proxy path uses safeRedirectFetch", () => {
    const src = readFileSync(join(root, "open-sse/utils/proxyFetch.js"), "utf8");
    const mitmBlock = src.slice(src.indexOf("if (shouldBypassMitmDns(targetUrl))"));
    expect(mitmBlock).toMatch(/safeRedirectFetch\(url,\s*options/);
    expect(mitmBlock.indexOf("safeRedirectFetch")).toBeLessThan(mitmBlock.indexOf("createBypassRequest"));
  });

  it("buildFetchResponse uses Headers with append for array values", () => {
    const src = readFileSync(join(root, "open-sse/utils/proxyFetch.js"), "utf8");
    expect(src).toMatch(/const headers = new Headers\(\)/);
    expect(src).toMatch(/headers\.append\(key, item\)/);
    expect(src).not.toMatch(/headers: new Map\(Object\.entries\(res\.headers\)\)/);
  });

  it("createBypassRequest uses URL port and http module for http:", () => {
    const src = readFileSync(join(root, "open-sse/utils/proxyFetch.js"), "utf8");
    expect(src).toContain('parsedUrl.protocol === "https:"');
    expect(src).toContain('import(isHttps ? "https" : "http")');
    expect(src).toMatch(/socket\.connect\(port,\s*realIP/);
  });
});
