/**
 * Open-sse bug fixes — v1beta Gemini, combo 404, tool placeholders, bypass merge, proxy stream bodies.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { isZeroConnectionsResponse } from "../../open-sse/services/combo.js";
import { fixMissingToolResponses } from "../../open-sse/translator/helpers/toolCallHelper.js";
import { initTranslators, translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import "../../open-sse/translator/request/gemini-to-openai.js";

const root = join(import.meta.dirname, "..", "..");

beforeEach(async () => {
  await initTranslators();
});

describe("translator init", () => {
  it("initializes under direct Node ESM import", () => {
    const result = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      "import('./open-sse/translator/index.js').then(m=>{m.initTranslators(); console.log('ok')}).catch(e=>{console.error(e?.stack||e); process.exit(1)})",
    ], { cwd: root, encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ok");
  });
});

describe("isZeroConnectionsResponse — plain text 404", () => {
  it("recognizes no-credentials message without JSON body", async () => {
    const response = new Response("No active credentials for provider: claude", {
      status: 404,
      headers: { "Content-Type": "text/plain" },
    });
    expect(await isZeroConnectionsResponse(response)).toBe(true);
  });

  it("still returns false for unrelated plain text 404", async () => {
    const response = new Response("not json", {
      status: 404,
      headers: { "Content-Type": "text/plain" },
    });
    expect(await isZeroConnectionsResponse(response)).toBe(false);
  });
});

describe("fixMissingToolResponses — non-empty placeholder", () => {
  it("uses minimal valid placeholder instead of empty string", () => {
    const body = {
      messages: [
        {
          role: "assistant",
          tool_calls: [{ id: "call_x", type: "function", function: { name: "fn", arguments: "{}" } }],
        },
        { role: "user", content: "next" },
      ],
    };
    fixMissingToolResponses(body);
    const toolMsg = body.messages.find((m) => m.role === "tool");
    expect(toolMsg.content).toBe("[No response received]");
  });
});

describe("Gemini request conversion — tool and multimodal parts", () => {
  it("maps functionCall and inlineData via translateRequest", () => {
    const geminiBody = {
      contents: [
        {
          role: "user",
          parts: [
            { text: "describe this" },
            { inlineData: { mimeType: "image/png", data: "abc123" } },
          ],
        },
        {
          role: "model",
          parts: [{ functionCall: { name: "lookup", args: { q: "x" } } }],
        },
        {
          role: "user",
          parts: [{ functionResponse: { id: "lookup", response: { result: "ok" } } }],
        },
      ],
    };

    const converted = translateRequest(FORMATS.GEMINI, FORMATS.OPENAI, "gemini/gemini-2.0", geminiBody, false);
    const userMsg = converted.messages.find((m) => m.role === "user" && Array.isArray(m.content));
    expect(userMsg.content.some((p) => p.type === "image_url")).toBe(true);
    const assistantMsg = converted.messages.find((m) => m.tool_calls?.length);
    expect(assistantMsg.tool_calls[0].function.name).toBe("lookup");
    const toolMsg = converted.messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeTruthy();
  });
});

describe("v1beta route source fixes", () => {
  const src = readFileSync(
    join(root, "src/app/api/v1beta/models/[...path]/route.js"),
    "utf8"
  );

  it("skips OpenAI→Gemini transform on passthrough and native Gemini SSE", () => {
    expect(src).toContain("isNativePassthrough");
    expect(src).toContain("passthroughOrTransformGeminiSSE");
    expect(src).toContain('peekFirstChunkIsGeminiSSE');
  });

  it("returns 502 when non-streaming response has no choices", () => {
    expect(src).toContain("Upstream returned empty completion");
    expect(src).toContain("status: 502");
  });

  it("fails on consecutive malformed SSE parse failures", () => {
    expect(src).toContain("consecutiveParseFailures");
    expect(src).toContain("Malformed SSE data after consecutive parse failures");
  });

  it("uses translateRequest for Gemini→internal conversion", () => {
    expect(src).toContain("translateRequest(FORMATS.GEMINI");
  });

  it("maps tool_calls in streaming and non-streaming converters", () => {
    expect(src).toContain("toolCallAccum");
    expect(src).toContain("message.tool_calls");
    expect(src).toContain("functionCall");
  });

  it("returns 400 for invalid JSON and translation failures", () => {
    expect(src).toContain("Invalid JSON body");
    expect(src).toContain("TRANSLATION_INVALID_BODY");
    expect(src).toMatch(/geminiErrorResponse\(\s*400/);
  });

  it("parses multi-segment model paths from last segment", () => {
    expect(src).toContain("parseV1BetaPath");
    expect(src).toContain("path.slice(0, -1).join");
  });
});

describe("Kiro assembleEventStreamToJSON fail-closed", () => {
  function buildKiroFrame(headers, payload) {
    const enc = new TextEncoder();
    const payloadBytes = enc.encode(JSON.stringify(payload));
    const headerParts = [];
    for (const [name, value] of Object.entries(headers)) {
      const nameBytes = enc.encode(name);
      const valueBytes = enc.encode(value);
      const part = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
      let i = 0;
      part[i++] = nameBytes.length;
      part.set(nameBytes, i); i += nameBytes.length;
      part[i++] = 7;
      part[i++] = (valueBytes.length >> 8) & 0xff;
      part[i++] = valueBytes.length & 0xff;
      part.set(valueBytes, i);
      headerParts.push(part);
    }
    const headersTotal = headerParts.reduce((n, p) => n + p.length, 0);
    const headersBytes = new Uint8Array(headersTotal);
    let off = 0;
    for (const p of headerParts) { headersBytes.set(p, off); off += p.length; }
    const totalLength = 12 + headersTotal + payloadBytes.length + 4;
    const frame = new Uint8Array(totalLength);
    const view = new DataView(frame.buffer);
    view.setUint32(0, totalLength, false);
    view.setUint32(4, headersTotal, false);
    view.setUint32(8, 0, false);
    frame.set(headersBytes, 12);
    frame.set(payloadBytes, 12 + headersTotal);
    return frame;
  }

  function makeKiroStream(frames) {
    const total = frames.reduce((n, f) => n + f.length, 0);
    const buf = new Uint8Array(total);
    let offset = 0;
    for (const f of frames) { buf.set(f, offset); offset += f.length; }
    return new ReadableStream({
      start(controller) { controller.enqueue(buf); controller.close(); },
    });
  }

  it("returns 502 when messageStopEvent is missing", async () => {
    const { KiroExecutor } = await import("../../open-sse/executors/kiro.js");
    const executor = new KiroExecutor();
    const frames = [
      buildKiroFrame({ ":event-type": "assistantResponseEvent" }, { content: "partial" }),
    ];
    const response = await executor.assembleEventStreamToJSON(
      new Response(makeKiroStream(frames), { status: 200 }),
      "kiro-model",
    );

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error.code).toBe("sse_assembly_failed");
    expect(body.error.message).toContain("messageStopEvent");
  });
});

describe("AssemblyAI STT poll fail-fast", () => {
  it("tracks consecutive poll errors before giving up", () => {
    const src = readFileSync(join(root, "open-sse/handlers/sttCore.js"), "utf8");
    expect(src).toContain("consecutivePollErrors");
    expect(src).toMatch(/consecutivePollErrors >= MAX_CONSECUTIVE_POLL_ERRORS/);
  });
});

describe("bypassHandler Claude delta accumulation", () => {
  it("accumulates all content_block_delta chunks", () => {
    const src = readFileSync(join(root, "open-sse/utils/bypassHandler.js"), "utf8");
    expect(src).toContain("accumulatedText");
    expect(src).not.toMatch(/chunks\.find\(c => c\.type === "content_block_delta"\)/);
  });
});

describe("proxyFetch MITM bypass stream bodies", () => {
  it("buffers stream bodies instead of throwing", () => {
    const src = readFileSync(join(root, "open-sse/utils/proxyFetch.js"), "utf8");
    expect(src).toContain("async function serializeBypassRequestBody");
    expect(src).not.toContain("Streaming request bodies are not supported");
    expect(src).toContain("getReader");
  });
});

describe("/v1/responses live path", () => {
  it("routes through handleChat, not deleted responsesHandler", () => {
    const routeSrc = readFileSync(join(root, "src/app/api/v1/responses/route.js"), "utf8");
    expect(routeSrc).toContain("handleChat");
    expect(routeSrc).not.toContain("handleResponsesCore");
    expect(routeSrc).toContain("sseToJsonHandler");
  });

  it("sseToJsonHandler owns Responses stream assembly", () => {
    const src = readFileSync(join(root, "open-sse/handlers/chatCore/sseToJsonHandler.js"), "utf8");
    expect(src).toContain("convertResponsesStreamToJson");
  });

  it("sseToJsonHandler logs OpenAI finish_reason not Responses status", () => {
    const src = readFileSync(join(root, "open-sse/handlers/chatCore/sseToJsonHandler.js"), "utf8");
    expect(src).toContain("logFinishReason");
    expect(src).not.toMatch(/finish_reason:\s*jsonResponse\.status/);
  });
});
