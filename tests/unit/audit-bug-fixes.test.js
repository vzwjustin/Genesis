// Regression tests for the advisor-pipeline bug audit (2026-06).
// Each describe block maps to a numbered finding from the audit report.
import { describe, it, expect } from "vitest";

import { openaiToClaudeRequest } from "../../open-sse/translator/request/openai-to-claude.js";
import { adjustMaxTokens } from "../../open-sse/translator/helpers/maxTokensHelper.js";
import { DEFAULT_MAX_TOKENS, DEFAULT_MIN_TOKENS } from "../../open-sse/config/runtimeConfig.js";
import { parseSSEToOpenAIResponse } from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";
import { cleanJSONSchemaForAntigravity } from "../../open-sse/translator/helpers/geminiHelper.js";
import { sanitizeValue } from "../../src/shared/utils/redaction.js";
import { isNativePassthrough, shouldUseNativePassthrough, parseStreamIntentHeader } from "../../open-sse/utils/clientDetector.js";
import { generateCursorChecksum } from "../../open-sse/utils/cursorChecksum.js";

const USER_MSG = [{ role: "user", content: "hi" }];

// Build an SSE blob from already-serialized data payloads.
const sse = (...payloads) => payloads.map((p) => `data: ${p}`).join("\n\n") + "\n\n";

// ============================================================================
// #1 — reasoning_effort + small max_tokens must not emit an invalid Claude body
// (Claude requires max_tokens strictly > thinking.budget_tokens)
// ============================================================================
describe("#1 reasoning_effort vs max_tokens invariant", () => {
  it("raises max_tokens above the reasoning_effort budget", () => {
    const r = openaiToClaudeRequest("claude-x", { max_tokens: 4096, reasoning_effort: "high", messages: USER_MSG }, false);
    expect(r.thinking).toEqual({ type: "enabled", budget_tokens: 16384 });
    expect(r.max_tokens).toBeGreaterThan(r.thinking.budget_tokens);
    expect(r.max_tokens).toBe(16384 + 1024);
  });

  it("leaves max_tokens untouched when it already exceeds the budget", () => {
    const r = openaiToClaudeRequest("claude-x", { max_tokens: 40000, reasoning_effort: "low", messages: USER_MSG }, false);
    expect(r.thinking.budget_tokens).toBe(4096);
    expect(r.max_tokens).toBe(40000);
  });

  it("does not inflate max_tokens for reasoning_effort:none (disabled thinking)", () => {
    const r = openaiToClaudeRequest("claude-x", { max_tokens: 4096, reasoning_effort: "none", messages: USER_MSG }, false);
    expect(r.thinking).toEqual({ type: "disabled" });
    expect(r.max_tokens).toBe(4096);
  });
});

// ============================================================================
// #6 — OpenAI temperature (0–2) must be clamped to the Claude range (0–1)
// ============================================================================
describe("#6 temperature clamping", () => {
  it("clamps a >1 temperature down to 1", () => {
    expect(openaiToClaudeRequest("m", { temperature: 1.5, messages: USER_MSG }, false).temperature).toBe(1);
    expect(openaiToClaudeRequest("m", { temperature: 2, messages: USER_MSG }, false).temperature).toBe(1);
  });

  it("clamps a negative temperature up to 0", () => {
    expect(openaiToClaudeRequest("m", { temperature: -0.5, messages: USER_MSG }, false).temperature).toBe(0);
  });

  it("passes through an in-range temperature unchanged", () => {
    expect(openaiToClaudeRequest("m", { temperature: 0.7, messages: USER_MSG }, false).temperature).toBe(0.7);
  });

  it("drops a non-numeric temperature rather than forwarding NaN", () => {
    expect(openaiToClaudeRequest("m", { temperature: "hot", messages: USER_MSG }, false).temperature).toBeUndefined();
  });

  it("omits temperature when the client did not send one", () => {
    expect(openaiToClaudeRequest("m", { messages: USER_MSG }, false).temperature).toBeUndefined();
  });

  it("omits temperature when the client sends null", () => {
    expect(openaiToClaudeRequest("m", { temperature: null, messages: USER_MSG }, false).temperature).toBeUndefined();
  });
});

// ============================================================================
// #8 — adjustMaxTokens numeric guards
// ============================================================================
describe("#8 adjustMaxTokens numeric guards", () => {
  it("falls back to default for 0 / negative / NaN", () => {
    expect(adjustMaxTokens({ max_tokens: 0 })).toBe(DEFAULT_MAX_TOKENS);
    expect(adjustMaxTokens({ max_tokens: -100 })).toBe(DEFAULT_MAX_TOKENS);
    expect(adjustMaxTokens({ max_tokens: NaN })).toBe(DEFAULT_MAX_TOKENS);
    expect(adjustMaxTokens({})).toBe(DEFAULT_MAX_TOKENS);
  });

  it("coerces a numeric string and floors a float", () => {
    expect(adjustMaxTokens({ max_tokens: "100" })).toBe(100);
    expect(adjustMaxTokens({ max_tokens: 100.7 })).toBe(100);
  });

  it("keeps a valid positive integer", () => {
    expect(adjustMaxTokens({ max_tokens: 4096 })).toBe(4096);
  });

  it("still enforces the thinking.budget_tokens floor", () => {
    expect(adjustMaxTokens({ max_tokens: 4096, thinking: { budget_tokens: 16384 } })).toBe(16384 + 1024);
  });

  it("still raises tiny max_tokens to the tool-calling floor when tools are present", () => {
    expect(adjustMaxTokens({ max_tokens: 10, tools: [{ name: "x" }] })).toBe(DEFAULT_MIN_TOKENS);
  });
});

// ============================================================================
// #3 — OpenAI SSE assembly must fail closed on error frames / truncated output
// ============================================================================
describe("#3 parseSSEToOpenAIResponse fail-closed assembly", () => {
  it("returns null when a mid-stream error frame appears", () => {
    const blob = sse(
      '{"choices":[{"delta":{"content":"partial"}}]}',
      '{"error":{"message":"upstream boom","type":"server_error"}}',
      "[DONE]"
    );
    expect(parseSSEToOpenAIResponse(blob, "m")).toBeNull();
  });

  it("returns null on a malformed (non-JSON) frame", () => {
    expect(parseSSEToOpenAIResponse(sse("{not json}", "[DONE]"), "m")).toBeNull();
  });

  it("returns null when the stream never signals completion", () => {
    // content but no finish_reason and no [DONE]
    expect(parseSSEToOpenAIResponse(sse('{"choices":[{"delta":{"content":"hello"}}]}'), "m")).toBeNull();
  });

  it("assembles a well-formed stream into one completion", () => {
    const blob = sse(
      '{"choices":[{"delta":{"content":"Hello"}}]}',
      '{"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}]}',
      "[DONE]"
    );
    const res = parseSSEToOpenAIResponse(blob, "m");
    expect(res.choices[0].message.content).toBe("Hello world");
    expect(res.choices[0].finish_reason).toBe("stop");
  });

  it("returns null when accumulated tool-call arguments are not valid JSON", () => {
    const blob = sse(
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"foo","arguments":"{\\"a\\":"}}]}}]}',
      "[DONE]"
    );
    expect(parseSSEToOpenAIResponse(blob, "m")).toBeNull();
  });

  it("corrects finish_reason to tool_calls when a provider terminates via bare [DONE]", () => {
    const blob = sse(
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"foo","arguments":"{}"}}]}}]}',
      "[DONE]"
    );
    const res = parseSSEToOpenAIResponse(blob, "m");
    expect(res.choices[0].message.tool_calls[0].function.name).toBe("foo");
    expect(res.choices[0].finish_reason).toBe("tool_calls");
  });

  it("preserves a provider truncation reason on a cut-off tool call", () => {
    const blob = sse(
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"foo","arguments":"{}"}}]},"finish_reason":"length"}]}',
      "[DONE]"
    );
    const res = parseSSEToOpenAIResponse(blob, "m");
    expect(res.choices[0].finish_reason).toBe("length");
  });
});

// ============================================================================
// #7 — Gemini schema cleaner must not delete user-defined parameter NAMES
// ============================================================================
describe("#7 Gemini schema cleaner preserves property names", () => {
  it("keeps parameters literally named format / title / default", () => {
    const schema = {
      type: "object",
      properties: {
        format: { type: "string", description: "an output format param" },
        title: { type: "string" },
        default: { type: "boolean" },
      },
      required: ["format", "title"],
    };
    const cleaned = cleanJSONSchemaForAntigravity(structuredClone(schema));
    expect(cleaned.properties.format).toBeDefined();
    expect(cleaned.properties.title).toBeDefined();
    expect(cleaned.properties.default).toBeDefined();
    expect(cleaned.required).toContain("format");
    expect(cleaned.required).toContain("title");
  });

  it("still strips real schema keyword constraints inside a property subschema", () => {
    const schema = {
      type: "object",
      properties: {
        email: { type: "string", format: "email", pattern: "^.+@.+$", title: "Email" },
      },
    };
    const cleaned = cleanJSONSchemaForAntigravity(structuredClone(schema));
    expect(cleaned.properties.email).toBeDefined();
    expect(cleaned.properties.email.type).toBe("string");
    // The real `format`/`pattern`/`title` CONSTRAINTS on the value are removed.
    expect(cleaned.properties.email.format).toBeUndefined();
    expect(cleaned.properties.email.pattern).toBeUndefined();
    expect(cleaned.properties.email.title).toBeUndefined();
  });

  it("handles a property named the same as a container keyword", () => {
    const schema = {
      type: "object",
      properties: {
        properties: { type: "array", items: { type: "string" } },
      },
    };
    const cleaned = cleanJSONSchemaForAntigravity(structuredClone(schema));
    expect(cleaned.properties.properties).toBeDefined();
    expect(cleaned.properties.properties.type).toBe("array");
  });
});

// ============================================================================
// #2 — redaction must never throw (cycles / pathological depth) into the path
// ============================================================================
describe("#2 sanitizeValue cycle & depth guards", () => {
  it("does not throw on a circular reference and marks the back-edge", () => {
    const obj = { a: 1 };
    obj.self = obj;
    let out;
    expect(() => { out = sanitizeValue(obj); }).not.toThrow();
    expect(out.a).toBe(1);
    expect(out.self).toBe("[circular]");
  });

  it("does not throw on pathological nesting depth", () => {
    const root = {};
    let cur = root;
    for (let i = 0; i < 1000; i++) {
      cur.next = {};
      cur = cur.next;
    }
    expect(() => sanitizeValue(root)).not.toThrow();
  });

  it("still drops sensitive keys and redacts secret strings", () => {
    const out = sanitizeValue({ api_key: "supersecret", note: "Bearer abc.def.ghi", keep: "ok" });
    expect(out.api_key).toBeUndefined();
    expect(out.keep).toBe("ok");
    expect(out.note).toContain("[redacted]");
  });
});

// ============================================================================
// clientDetector null-provider guard (Low) — must fail closed, not throw
// ============================================================================
describe("clientDetector null/undefined provider guard", () => {
  it("isNativePassthrough returns false (no throw) for a null provider", () => {
    expect(() => isNativePassthrough("claude", null)).not.toThrow();
    expect(isNativePassthrough("claude", null)).toBe(false);
    expect(isNativePassthrough("claude", undefined)).toBe(false);
  });

  it("shouldUseNativePassthrough returns false (no throw) for a null provider", () => {
    expect(() => shouldUseNativePassthrough("claude", null, { body: {}, headers: {} })).not.toThrow();
    expect(shouldUseNativePassthrough("claude", null, { body: {}, headers: {} })).toBe(false);
  });

  it("still recognizes a real native pair", () => {
    expect(isNativePassthrough("claude", "anthropic-compatible-foo")).toBe(true);
    expect(isNativePassthrough("openai", "openai")).toBe(true);
  });
});

// ============================================================================
// #12 — Gemini-family stream intent: the verb (surfaced as x-genesis-stream-intent)
// must be honored so a :generateContent client is not force-streamed raw SSE.
// ============================================================================
describe("#12 parseStreamIntentHeader (Gemini verb → stream intent)", () => {
  it("reads an explicit non-streaming signal (:generateContent → '0')", () => {
    expect(parseStreamIntentHeader({ "x-genesis-stream-intent": "0" })).toBe(false);
    expect(parseStreamIntentHeader({ "x-genesis-stream-intent": "false" })).toBe(false);
  });

  it("reads an explicit streaming signal (:streamGenerateContent → '1')", () => {
    expect(parseStreamIntentHeader({ "x-genesis-stream-intent": "1" })).toBe(true);
    expect(parseStreamIntentHeader({ "x-genesis-stream-intent": "true" })).toBe(true);
  });

  it("is case-insensitive on the header key", () => {
    expect(parseStreamIntentHeader({ "X-Genesis-Stream-Intent": "0" })).toBe(false);
  });

  it("returns null when absent or unrecognized (caller keeps its default)", () => {
    expect(parseStreamIntentHeader({})).toBeNull();
    expect(parseStreamIntentHeader({ "x-genesis-stream-intent": "maybe" })).toBeNull();
    expect(parseStreamIntentHeader(null)).toBeNull();
    expect(parseStreamIntentHeader(undefined)).toBeNull();
  });
});

// ============================================================================
// Cursor Checksum Big-Endian Shift Fix
// ============================================================================
describe("Cursor Checksum Big-Endian Shift Fix", () => {
  it("generates correct 6-byte big-endian representation without shift wrap-around", () => {
    const originalDateNow = Date.now;
    try {
      // 1781482156000 ms -> 1781482 seconds -> 0x1B2EEA
      Date.now = () => 1781482156000;
      const checksum = generateCursorChecksum("test-machine");
      expect(checksum).toBeDefined();
      expect(checksum.length).toBeGreaterThan(0);
      
      // Let's verify the base64 part matches the expected correct big-endian byte array:
      // timestamp = 1781482 -> [0, 0, 0, 0x1B, 0x2E, 0xEA]
      // obfuscation with t=165:
      // i=0: b[0] = (0 ^ 165) + 0 = 165 & 0xFF = 165 (0xA5)
      // i=1: b[1] = (0 ^ 165) + 1 = 166 & 0xFF = 166 (0xA6)
      // i=2: b[2] = (0 ^ 166) + 2 = 168 & 0xFF = 168 (0xA8)
      // i=3: b[3] = (0x1B ^ 168) + 3 = 179 + 3 = 182 & 0xFF = 182 (0xB6)
      // i=4: b[4] = (0x2E ^ 182) + 4 = 152 + 4 = 156 & 0xFF = 156 (0x9C)
      // i=5: b[5] = (0xEA ^ 156) + 5 = 118 + 5 = 123 & 0xFF = 123 (0x7B)
      // Obfuscated array: [165, 166, 168, 182, 156, 123] -> [0xA5, 0xA6, 0xA8, 0xB6, 0x9C, 0x7B]
      // Base64 encoding:
      // a = 0xA5, b = 0xA6, c = 0xA8 -> 0xA5A6A8 -> 10100101 10100110 10101000
      // 6-bit chunks: 101001 (41 -> p), 011010 (26 -> a), 011010 (26 -> a), 101000 (40 -> o) -> "paao"
      // d = 0xB6, e = 0x9C, f = 0x7B -> 0xB69C7B -> 10110110 10011100 01111011
      // 6-bit chunks: 101101 (45 -> t), 101001 (41 -> p), 110001 (49 -> x), 111011 (59 -> 7) -> "tpx7"
      // Combined base64 string: "paaotpx7"
      expect(checksum).toBe("paaotpx7test-machine");
    } finally {
      Date.now = originalDateNow;
    }
  });
});
