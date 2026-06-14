/**
 * Wave 2 — RTK Gemini cache integrity, finish reason, thinking config, tool name mapping
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { compressMessages } from "../../open-sse/rtk/index.js";
import { geminiToOpenAIResponse } from "../../open-sse/translator/response/gemini-to-openai.js";
import {
  openaiToGeminiRequest,
  openaiToAntigravityRequest,
} from "../../open-sse/translator/request/openai-to-gemini.js";

function makeLongDiff() {
  const lines = ["diff --git a/foo.js b/foo.js", "index abc..def 100644", "--- a/foo.js", "+++ b/foo.js", "@@ -1,3 +1,200 @@"];
  for (let i = 0; i < 200; i++) lines.push(`+added line ${i} ${"x".repeat(20)}`);
  return lines.join("\n");
}

describe("compressGeminiContents cache boundary integrity", () => {
  it("compresses functionResponse when no cache markers are present", () => {
    const compressible = makeLongDiff();
    const body = {
      contents: [{
        role: "user",
        parts: [{
          functionResponse: {
            id: "call_1",
            name: "read_file",
            response: { result: compressible },
          },
        }],
      }],
    };

    const stats = compressMessages(body, true);
    expect(stats).not.toBeNull();
    expect(stats.hits.length).toBeGreaterThan(0);
    const result = body.contents[0].parts[0].functionResponse.response.result;
    const resultText = typeof result === "string" ? result : JSON.stringify(result);
    expect(resultText.length).toBeLessThan(compressible.length);
  });

  it("skips compressing cache-protected gemini contents but compresses uncached tail", () => {
    const payload = makeLongDiff();
    const body = {
      contents: [
        {
          role: "user",
          cache_control: { type: "ephemeral" },
          parts: [{
            functionResponse: {
              id: "call_protected",
              name: "read_file",
              response: { result: "cached payload" },
            },
          }],
        },
        {
          role: "user",
          parts: [{
            functionResponse: {
              id: "call_tail",
              name: "read_file",
              response: { result: payload },
            },
          }],
        },
      ],
    };

    const stats = compressMessages(body, true);
    expect(stats).not.toBeNull();
    expect(body.contents[0].parts[0].functionResponse.response.result).toBe("cached payload");
    const tail = body.contents[1].parts[0].functionResponse.response.result;
    const tailText = typeof tail === "string" ? tail : JSON.stringify(tail);
    expect(tailText.length).toBeLessThan(payload.length);
  });
});

describe("gemini-to-openai finishReason mapping", () => {
  it("maps function_calls finish reason to tool_calls", () => {
    const state = { toolCalls: new Map(), functionIndex: 0 };
    const chunks = geminiToOpenAIResponse({
      candidates: [{
        content: { parts: [{ text: "done" }] },
        finishReason: "FUNCTION_CALLS",
      }],
    }, state);

    const finalChunk = chunks.flat().find((c) => c.choices?.[0]?.finish_reason);
    expect(finalChunk?.choices?.[0]?.finish_reason).toBe("tool_calls");
  });
});

describe("wrapInCloudCodeEnvelopeForClaude thinking config", () => {
  it("includes thinkingConfig when claude thinking is enabled", () => {
    const out = openaiToAntigravityRequest(
      "claude-opus-4-6",
      {
        messages: [{ role: "user", content: "hi" }],
        thinking: { type: "enabled", budget_tokens: 16000 },
      },
      false,
    );

    expect(out.request.generationConfig.thinkingConfig).toEqual({
      thinkingBudget: 16000,
      include_thoughts: true,
    });
  });

  it("omits thinkingConfig when thinking is disabled", () => {
    const out = openaiToAntigravityRequest(
      "claude-opus-4-6",
      {
        messages: [{ role: "user", content: "hi" }],
        thinking: { type: "disabled" },
      },
      false,
    );

    expect(out.request.generationConfig.thinkingConfig).toBeUndefined();
  });
});

describe("openai-to-gemini functionResponse name mapping", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warns and skips functionResponse when tcID2Name has no entry", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const out = openaiToGeminiRequest("gemini-2.0", {
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: "call_missing_name",
            type: "function",
            function: { arguments: "{}" },
          }],
        },
        {
          role: "tool",
          tool_call_id: "call_missing_name",
          content: "tool output",
        },
      ],
    }, false);

    const functionResponses = out.contents.flatMap((c) =>
      (c.parts || []).filter((p) => p.functionResponse),
    );
    expect(functionResponses).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("call_missing_name"),
    );
  });
});
