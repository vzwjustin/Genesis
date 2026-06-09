import { describe, expect, it, beforeAll } from "vitest";
import { translateResponse, initState } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { openaiToGeminiResponse } from "../../open-sse/translator/response/openai-to-gemini.js";
import { translateNonStreamingResponse } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";

// Import translators to trigger their register() calls
import "../../open-sse/translator/response/claude-to-openai.js";
import "../../open-sse/translator/response/openai-to-claude.js";
import "../../open-sse/translator/response/gemini-to-openai.js";
import "../../open-sse/translator/response/openai-to-gemini.js";
import "../../open-sse/translator/response/openai-to-antigravity.js";
import "../../open-sse/translator/response/openai-responses.js";

// Helper: create a basic OpenAI streaming chunk with text content
function openaiTextChunk(content, model = "gpt-4") {
  return {
    id: "chatcmpl-test123",
    object: "chat.completion.chunk",
    created: 1700000000,
    model,
    choices: [{ index: 0, delta: { content }, finish_reason: null }]
  };
}

// Helper: create an OpenAI chunk with finish_reason
function openaiFinishChunk(finishReason = "stop", usage = null, model = "gpt-4") {
  const chunk = {
    id: "chatcmpl-test123",
    object: "chat.completion.chunk",
    created: 1700000000,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }]
  };
  if (usage) chunk.usage = usage;
  return chunk;
}

// Helper: create a Claude streaming response
function claudeMessageStart() {
  return { type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model: "claude-3-5-sonnet", content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 0 } } };
}

function claudeContentDelta(text) {
  return { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } };
}

function claudeMessageDelta(stopReason = "end_turn") {
  return { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 50 } };
}

// Helper: Gemini streaming response
function geminiStreamChunk(text, finishReason = null) {
  const chunk = {
    candidates: [{
      content: { role: "model", parts: [{ text }] }
    }],
    modelVersion: "gemini-1.5-pro",
    responseId: "resp_test123"
  };
  if (finishReason) chunk.candidates[0].finishReason = finishReason;
  return chunk;
}

describe("Response Translation Pipeline - Streaming", () => {
  describe("translateResponse: same format passthrough", () => {
    it("returns chunk as-is when source === target", () => {
      const chunk = openaiTextChunk("hello");
      const state = initState(FORMATS.OPENAI);
      const results = translateResponse(FORMATS.OPENAI, FORMATS.OPENAI, chunk, state);
      expect(results).toEqual([chunk]);
    });
  });

  describe("translateResponse: target → OpenAI (step 1 only)", () => {
    it("translates Claude streaming events to OpenAI chunks when source is OpenAI", () => {
      const state = initState(FORMATS.OPENAI);
      // message_start
      const r1 = translateResponse(FORMATS.CLAUDE, FORMATS.OPENAI, claudeMessageStart(), state);
      expect(r1.length).toBeGreaterThan(0);
      // content_block_delta
      const r2 = translateResponse(FORMATS.CLAUDE, FORMATS.OPENAI, claudeContentDelta("hello"), state);
      expect(r2.length).toBeGreaterThan(0);
      // Verify it's an OpenAI chunk
      const textChunk = r2.find(c => c.choices?.[0]?.delta?.content);
      expect(textChunk.choices[0].delta.content).toBe("hello");
    });

    it("translates Gemini streaming to OpenAI chunks when source is OpenAI", () => {
      const state = initState(FORMATS.OPENAI);
      const results = translateResponse(FORMATS.GEMINI, FORMATS.OPENAI, geminiStreamChunk("hello world", "STOP"), state);
      expect(results.length).toBeGreaterThan(0);
      const textChunk = results.find(c => c.choices?.[0]?.delta?.content);
      expect(textChunk.choices[0].delta.content).toBe("hello world");
    });
  });

  describe("translateResponse: OpenAI → Claude (step 2 only)", () => {
    it("translates OpenAI chunks to Claude streaming events when target is OpenAI, source is Claude", () => {
      const state = initState(FORMATS.CLAUDE);
      const chunk = openaiTextChunk("hello");
      const r1 = translateResponse(FORMATS.OPENAI, FORMATS.CLAUDE, chunk, state);
      expect(r1.length).toBeGreaterThan(0);
      // openaiToClaudeResponse returns flat array of Claude event objects
      const msgStart = r1.find(e => e.type === "message_start");
      expect(msgStart).toBeDefined();
      const delta = r1.find(e => e.type === "content_block_delta");
      expect(delta).toBeDefined();
      expect(delta.delta.text).toBe("hello");
    });

    it("emits message_stop on finish_reason", () => {
      const state = initState(FORMATS.CLAUDE);
      translateResponse(FORMATS.OPENAI, FORMATS.CLAUDE, openaiTextChunk("hi"), state);
      const results = translateResponse(FORMATS.OPENAI, FORMATS.CLAUDE, openaiFinishChunk("stop"), state);
      const msgStop = results.find(e => e.type === "message_stop");
      expect(msgStop).toBeDefined();
    });
  });

  describe("translateResponse: OpenAI → Gemini (step 2 - new translator)", () => {
    it("translates OpenAI text chunk to Gemini format", () => {
      const state = initState(FORMATS.GEMINI);
      const results = translateResponse(FORMATS.OPENAI, FORMATS.GEMINI, openaiTextChunk("hello gemini"), state);
      expect(results.length).toBe(1);
      expect(results[0].candidates[0].content.role).toBe("model");
      expect(results[0].candidates[0].content.parts[0].text).toBe("hello gemini");
      // Should NOT have a response wrapper (that's Antigravity)
      expect(results[0].response).toBeUndefined();
    });

    it("translates OpenAI finish chunk with finishReason", () => {
      const state = initState(FORMATS.GEMINI);
      translateResponse(FORMATS.OPENAI, FORMATS.GEMINI, openaiTextChunk("hi"), state);
      const results = translateResponse(FORMATS.OPENAI, FORMATS.GEMINI, openaiFinishChunk("stop", { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }), state);
      expect(results.length).toBe(1);
      expect(results[0].candidates[0].finishReason).toBe("STOP");
      expect(results[0].usageMetadata.promptTokenCount).toBe(10);
      expect(results[0].usageMetadata.candidatesTokenCount).toBe(5);
    });

    it("handles reasoning_content as thought parts", () => {
      const state = initState(FORMATS.GEMINI);
      const chunk = {
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        created: 1700000000,
        model: "gpt-4",
        choices: [{ index: 0, delta: { reasoning_content: "thinking..." }, finish_reason: null }]
      };
      const results = translateResponse(FORMATS.OPENAI, FORMATS.GEMINI, chunk, state);
      expect(results.length).toBe(1);
      expect(results[0].candidates[0].content.parts[0].thought).toBe(true);
      expect(results[0].candidates[0].content.parts[0].text).toBe("thinking...");
    });

    it("accumulates tool calls and emits on finish", () => {
      const state = initState(FORMATS.GEMINI);
      // Tool call start
      const tc1 = {
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        created: 1700000000,
        model: "gpt-4",
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_123", function: { name: "get_weather", arguments: "" } }] }, finish_reason: null }]
      };
      const r1 = translateResponse(FORMATS.OPENAI, FORMATS.GEMINI, tc1, state);
      expect(r1.length).toBe(0); // Accumulating, no emit yet

      // Tool call args
      const tc2 = {
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        created: 1700000000,
        model: "gpt-4",
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"NYC"}' } }] }, finish_reason: null }]
      };
      const r2 = translateResponse(FORMATS.OPENAI, FORMATS.GEMINI, tc2, state);
      expect(r2.length).toBe(0); // Still accumulating

      // Finish
      const r3 = translateResponse(FORMATS.OPENAI, FORMATS.GEMINI, openaiFinishChunk("tool_calls"), state);
      expect(r3.length).toBe(1);
      const parts = r3[0].candidates[0].content.parts;
      const functionCallPart = parts.find(p => p.functionCall);
      expect(functionCallPart.functionCall.name).toBe("get_weather");
      expect(functionCallPart.functionCall.args).toEqual({ city: "NYC" });
    });

    it("works for GEMINI_CLI source format too", () => {
      const state = initState(FORMATS.GEMINI_CLI);
      const results = translateResponse(FORMATS.OPENAI, FORMATS.GEMINI_CLI, openaiTextChunk("hello cli"), state);
      expect(results.length).toBe(1);
      expect(results[0].candidates[0].content.parts[0].text).toBe("hello cli");
    });
  });

  describe("translateResponse: two-step Claude → Gemini", () => {
    it("translates Claude response to Gemini format via OpenAI intermediate", () => {
      const state = initState(FORMATS.GEMINI);
      // Claude message_start
      translateResponse(FORMATS.CLAUDE, FORMATS.GEMINI, claudeMessageStart(), state);
      // Claude content delta
      const r2 = translateResponse(FORMATS.CLAUDE, FORMATS.GEMINI, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, state);
      const r3 = translateResponse(FORMATS.CLAUDE, FORMATS.GEMINI, claudeContentDelta("hello from claude"), state);
      // Verify we get Gemini format out
      const geminiChunks = r3.filter(c => c.candidates);
      expect(geminiChunks.length).toBeGreaterThan(0);
      expect(geminiChunks[0].candidates[0].content.parts[0].text).toBe("hello from claude");
    });
  });

  describe("translateResponse: null chunk flush handling", () => {
    it("flushes step-2 translator when step-1 produces no output", () => {
      const state = initState(FORMATS.CLAUDE);
      // Send content through the OpenAI→Claude path (target=openai, source=claude)
      translateResponse(FORMATS.OPENAI, FORMATS.CLAUDE, openaiTextChunk("hello"), state);
      translateResponse(FORMATS.OPENAI, FORMATS.CLAUDE, openaiFinishChunk("stop"), state);
      // Null flush should not error
      const flushed = translateResponse(FORMATS.OPENAI, FORMATS.CLAUDE, null, state);
      // Should return empty array (already flushed by finish_reason)
      expect(Array.isArray(flushed)).toBe(true);
    });

    it("flushes both steps in two-step translation", () => {
      const state = initState(FORMATS.GEMINI);
      translateResponse(FORMATS.CLAUDE, FORMATS.GEMINI, claudeMessageStart(), state);
      translateResponse(FORMATS.CLAUDE, FORMATS.GEMINI, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, state);
      translateResponse(FORMATS.CLAUDE, FORMATS.GEMINI, claudeContentDelta("text"), state);
      translateResponse(FORMATS.CLAUDE, FORMATS.GEMINI, claudeMessageDelta("end_turn"), state);
      // Null flush
      const flushed = translateResponse(FORMATS.CLAUDE, FORMATS.GEMINI, null, state);
      expect(Array.isArray(flushed)).toBe(true);
    });
  });

  describe("translateResponse: OpenAI → Antigravity (existing)", () => {
    it("wraps in { response: ... } for Antigravity format", () => {
      const state = initState(FORMATS.ANTIGRAVITY);
      const results = translateResponse(FORMATS.OPENAI, FORMATS.ANTIGRAVITY, openaiTextChunk("hello ag"), state);
      expect(results.length).toBe(1);
      expect(results[0].response).toBeDefined();
      expect(results[0].response.candidates[0].content.parts[0].text).toBe("hello ag");
    });
  });

  describe("translateResponse: OpenAI → OpenAI-Responses", () => {
    it("translates OpenAI chunks to Responses API events", () => {
      const state = initState(FORMATS.OPENAI_RESPONSES);
      const results = translateResponse(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, openaiTextChunk("hello"), state);
      expect(results.length).toBeGreaterThan(0);
      // Should include response.created and text delta events
      const textDelta = results.find(e => e.data?.type === "response.output_text.delta");
      expect(textDelta).toBeDefined();
      expect(textDelta.data.delta).toBe("hello");
    });
  });
});

describe("Response Translation Pipeline - Non-Streaming", () => {
  // Helper: create a full OpenAI non-streaming response
  function openaiFullResponse(content = "Hello world", model = "gpt-4") {
    return {
      id: "chatcmpl-test123",
      object: "chat.completion",
      created: 1700000000,
      model,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    };
  }

  // Helper: Claude non-streaming response
  function claudeFullResponse(text = "Hello world") {
    return {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-3-5-sonnet",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 }
    };
  }

  // Helper: Gemini non-streaming response
  function geminiFullResponse(text = "Hello world") {
    return {
      candidates: [{
        content: { role: "model", parts: [{ text }] },
        finishReason: "STOP"
      }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
      modelVersion: "gemini-1.5-pro",
      responseId: "resp_test"
    };
  }

  describe("translateNonStreamingResponse: same format", () => {
    it("returns body unchanged when target === source", () => {
      const body = openaiFullResponse();
      const result = translateNonStreamingResponse(body, FORMATS.OPENAI, FORMATS.OPENAI);
      expect(result).toBe(body);
    });
  });

  describe("translateNonStreamingResponse: target → OpenAI (source=OpenAI)", () => {
    it("translates Claude response to OpenAI format", () => {
      const result = translateNonStreamingResponse(claudeFullResponse("test"), FORMATS.CLAUDE, FORMATS.OPENAI);
      expect(result.object).toBe("chat.completion");
      expect(result.choices[0].message.content).toBe("test");
      expect(result.choices[0].finish_reason).toBe("stop");
    });

    it("translates Gemini response to OpenAI format", () => {
      const result = translateNonStreamingResponse(geminiFullResponse("from gemini"), FORMATS.GEMINI, FORMATS.OPENAI);
      expect(result.object).toBe("chat.completion");
      expect(result.choices[0].message.content).toBe("from gemini");
    });
  });

  describe("translateNonStreamingResponse: target → source via OpenAI intermediate", () => {
    it("translates Claude target to Gemini source via OpenAI", () => {
      const result = translateNonStreamingResponse(claudeFullResponse("hello"), FORMATS.CLAUDE, FORMATS.GEMINI);
      expect(result.candidates).toBeDefined();
      expect(result.candidates[0].content.parts[0].text).toBe("hello");
      expect(result.candidates[0].finishReason).toBe("STOP");
      // Should NOT have response wrapper (that's Antigravity)
      expect(result.response).toBeUndefined();
    });

    it("translates Gemini target to Claude source via OpenAI", () => {
      const result = translateNonStreamingResponse(geminiFullResponse("from gemini"), FORMATS.GEMINI, FORMATS.CLAUDE);
      expect(result.type).toBe("message");
      expect(result.role).toBe("assistant");
      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toBe("from gemini");
      expect(result.stop_reason).toBe("end_turn");
    });

    it("translates OpenAI target to Claude source", () => {
      const result = translateNonStreamingResponse(openaiFullResponse("from openai"), FORMATS.OPENAI, FORMATS.CLAUDE);
      expect(result.type).toBe("message");
      expect(result.role).toBe("assistant");
      expect(result.content[0].text).toBe("from openai");
      expect(result.usage.input_tokens).toBe(10);
      expect(result.usage.output_tokens).toBe(5);
    });

    it("translates OpenAI target to Gemini source", () => {
      const result = translateNonStreamingResponse(openaiFullResponse("from openai"), FORMATS.OPENAI, FORMATS.GEMINI);
      expect(result.candidates[0].content.parts[0].text).toBe("from openai");
      expect(result.candidates[0].finishReason).toBe("STOP");
      expect(result.usageMetadata.promptTokenCount).toBe(10);
      expect(result.usageMetadata.candidatesTokenCount).toBe(5);
    });

    it("translates OpenAI target to Antigravity source", () => {
      const result = translateNonStreamingResponse(openaiFullResponse("from openai"), FORMATS.OPENAI, FORMATS.ANTIGRAVITY);
      expect(result.response).toBeDefined();
      expect(result.response.candidates[0].content.parts[0].text).toBe("from openai");
    });

    it("handles tool_calls in Claude→Gemini translation", () => {
      const claudeBody = {
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-3-5-sonnet",
        content: [
          { type: "text", text: "Let me check the weather" },
          { type: "tool_use", id: "toolu_123", name: "get_weather", input: { city: "NYC" } }
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5 }
      };
      const result = translateNonStreamingResponse(claudeBody, FORMATS.CLAUDE, FORMATS.GEMINI);
      expect(result.candidates).toBeDefined();
      const parts = result.candidates[0].content.parts;
      const textPart = parts.find(p => p.text && !p.functionCall);
      const funcPart = parts.find(p => p.functionCall);
      expect(textPart.text).toBe("Let me check the weather");
      expect(funcPart.functionCall.name).toBe("get_weather");
      expect(funcPart.functionCall.args).toEqual({ city: "NYC" });
    });
  });

  describe("translateNonStreamingResponse: OpenAI target, source is OpenAI", () => {
    it("returns body unchanged when target is OpenAI and source is OpenAI", () => {
      const body = openaiFullResponse();
      const result = translateNonStreamingResponse(body, FORMATS.OPENAI, FORMATS.OPENAI);
      expect(result).toBe(body);
    });
  });
});

describe("openaiToGeminiResponse unit tests", () => {
  it("returns null for null chunk (flush)", () => {
    const state = {};
    const result = openaiToGeminiResponse(null, state);
    expect(result).toBeNull();
  });

  it("returns null for chunk without choices", () => {
    const state = {};
    const result = openaiToGeminiResponse({ id: "test", usage: { prompt_tokens: 5 } }, state);
    expect(result).toBeNull();
    // But stores usage in state
    expect(state._usage.prompt_tokens).toBe(5);
  });

  it("skips empty non-finish chunks", () => {
    const state = {};
    const result = openaiToGeminiResponse({
      id: "test",
      model: "gpt-4",
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }]
    }, state);
    expect(result).toBeNull();
  });

  it("maps finish_reason 'length' to MAX_TOKENS", () => {
    const state = { _toolCallAccum: {} };
    const result = openaiToGeminiResponse(openaiFinishChunk("length"), state);
    expect(result.candidates[0].finishReason).toBe("MAX_TOKENS");
  });

  it("maps finish_reason 'content_filter' to SAFETY", () => {
    const state = { _toolCallAccum: {} };
    const result = openaiToGeminiResponse(openaiFinishChunk("content_filter"), state);
    expect(result.candidates[0].finishReason).toBe("SAFETY");
  });

  it("includes usage from state._usage on finish if not in chunk", () => {
    const state = { _toolCallAccum: {}, _usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } };
    const result = openaiToGeminiResponse(openaiFinishChunk("stop"), state);
    expect(result.usageMetadata.promptTokenCount).toBe(100);
    expect(result.usageMetadata.candidatesTokenCount).toBe(50);
  });
});
