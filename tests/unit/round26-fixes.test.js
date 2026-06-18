/**
 * Round 26 — remaining bug-hunt fixes:
 * Gemini SSE assembly, combo rotation lock, translator fail-closed,
 * passthrough usage accounting, env proxy fail-closed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FORMATS } from "../../open-sse/translator/formats.js";
import {
  parseSSEToGeminiResponse,
  parseSSEToNativeResponse,
} from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";
import { extractUsageFromResponse } from "../../open-sse/handlers/chatCore/requestDetail.js";
import { handleComboChat, resetComboRotation, getRotatedModels } from "../../open-sse/services/combo.js";

// Load translator registrations used by translateRequest
import "../../open-sse/translator/request/claude-to-openai.js";
import "../../open-sse/translator/request/openai-to-claude.js";
import { translateRequest } from "../../open-sse/translator/index.js";

const root = join(import.meta.dirname, "..", "..");

function makeResponse(status, body = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Round 26 — Gemini native SSE assembly", () => {
  it("assembles Gemini streaming chunks into a single JSON response", () => {
    const sse = [
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Hel"}]},"index":0}],"modelVersion":"gemini-2.0-flash","responseId":"r1"}',
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"lo"}]},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":2,"totalTokenCount":12}}',
    ].join("\n");

    const parsed = parseSSEToGeminiResponse(sse, false);
    expect(parsed.candidates[0].content.parts[0].text).toBe("Hello");
    expect(parsed.candidates[0].finishReason).toBe("STOP");
    expect(parsed.usageMetadata.totalTokenCount).toBe(12);
  });

  it("wraps Antigravity SSE in { response: ... }", () => {
    const sse = 'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"Hi"}]},"finishReason":"STOP"}],"modelVersion":"gemini"}}';
    const parsed = parseSSEToGeminiResponse(sse, true);
    expect(parsed.response.candidates[0].content.parts[0].text).toBe("Hi");
  });

  it("parseSSEToNativeResponse routes GEMINI format to Gemini assembler", async () => {
    const sse = 'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"OK"}]},"finishReason":"STOP"}]}';
    const parsed = await parseSSEToNativeResponse(sse, FORMATS.GEMINI, "gemini-2.0-flash");
    expect(parsed.candidates[0].content.parts[0].text).toBe("OK");
  });

  it("returns null for truncated Gemini SSE without finishReason", () => {
    const sse = 'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"partial"}]}}]}';
    expect(parseSSEToGeminiResponse(sse, false)).toBeNull();
  });
});

describe("Round 26 — translateRequest fails closed on missing translator", () => {
  it("throws when no request translator exists for source format", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    expect(() => translateRequest(FORMATS.VERTEX, FORMATS.CLAUDE, "m", body, false))
      .toThrow(/No request translator registered for vertex:openai/);
  });
});

describe("Round 26 — combo round-robin concurrency lock", () => {
  const mockLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    resetComboRotation();
  });

  it("allows concurrent handleSingleModel while serializing rotation setup", async () => {
    const models = ["cc/opus", "openai/gpt-4o"];
    let inFlight = 0;
    let maxConcurrent = 0;

    const handleSingleModel = vi.fn(async () => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 40));
      inFlight -= 1;
      return makeResponse(200, { ok: true });
    });

    await Promise.all([
      handleComboChat({
        body: { messages: [] },
        models,
        handleSingleModel,
        log: mockLog,
        comboName: "concurrent-combo",
        comboStrategy: "round-robin",
        comboStickyLimit: 1,
      }),
      handleComboChat({
        body: { messages: [] },
        models,
        handleSingleModel,
        log: mockLog,
        comboName: "concurrent-combo",
        comboStrategy: "round-robin",
        comboStickyLimit: 1,
      }),
    ]);

    expect(maxConcurrent).toBe(2);
    expect(handleSingleModel.mock.calls[0][1]).toBe("cc/opus");
    expect(handleSingleModel.mock.calls[1][1]).toBe("openai/gpt-4o");
    expect(getRotatedModels(models, "concurrent-combo", "round-robin", 1)[0]).toBe("cc/opus");
  });
});

describe("Round 26 — passthrough usage and Antigravity logging", () => {
  it("extractUsageFromResponse reads wrapped Antigravity usageMetadata", () => {
    const usage = extractUsageFromResponse({
      response: {
        usageMetadata: {
          promptTokenCount: 11,
          candidatesTokenCount: 4,
          thoughtsTokenCount: 2,
        },
      },
    });
    expect(usage).toEqual({
      prompt_tokens: 11,
      completion_tokens: 4,
      reasoning_tokens: 2,
    });
  });

  it("passthrough flush uses sourceFormat for usage estimation", () => {
    const src = readFileSync(join(root, "open-sse/utils/stream.js"), "utf8");
    expect(src).toMatch(/estimateUsage\(body, totalContentLength, sourceFormat/);
    expect(src).toContain('parsed.type === "content_block_delta"');
    expect(src).toContain("geminiBody.candidates");
  });
});

describe("Round 26 — env proxy fail-closed", () => {
  it("proxyAwareFetch does not fall back to direct when env proxy is configured", () => {
    const src = readFileSync(join(root, "open-sse/utils/proxyFetch.js"), "utf8");
    expect(src).toContain("strictProxy !== false");
    expect(src).not.toMatch(/Proxy failed, falling back to direct:\s*\$\{proxyError\.message\}\`;\s*return originalFetch\(url, options\);/);
  });
});
