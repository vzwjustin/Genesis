import { register } from "../registry.js";
import { FORMATS } from "../formats.js";

/**
 * Convert OpenAI SSE chunk to Gemini streaming format.
 * 
 * Gemini streaming format:
 *   data: {"candidates":[{"content":{"role":"model","parts":[{"text":"..."}]},"finishReason":"STOP"}],"usageMetadata":{...},"modelVersion":"..."}
 *
 * Tool calls: OpenAI sends incremental args across chunks → accumulate and emit ONCE at finish.
 *
 * This is the step-2 translator for clients whose Source_Format is GEMINI or GEMINI_CLI.
 * It converts OpenAI intermediate chunks back to Gemini format so the client receives
 * responses in the format it originally sent requests in.
 */
export function openaiToGeminiResponse(chunk, state) {
  if (!chunk) return null;

  const choice = chunk.choices?.[0];
  if (!choice) {
    if (chunk.usage) {
      state._usage = chunk.usage;
    }
    return null;
  }

  const delta = choice.delta || {};
  const finishReason = choice.finish_reason;

  // Init state
  if (!state._toolCallAccum) state._toolCallAccum = {};
  if (!state._responseId) state._responseId = chunk.id || `resp_${Date.now()}`;
  if (!state._modelVersion) state._modelVersion = chunk.model || "";

  const parts = [];

  // Thinking/reasoning → thought part
  if (delta.reasoning_content) {
    parts.push({ thought: true, text: delta.reasoning_content });
  }

  // Text content
  if (delta.content) {
    parts.push({ text: delta.content });
  }

  // Accumulate tool calls silently (no emit until finish)
  if (delta.tool_calls) {
    for (const tc of delta.tool_calls) {
      const idx = tc.index ?? 0;
      if (!state._toolCallAccum[idx]) {
        state._toolCallAccum[idx] = { id: "", name: "", arguments: "" };
      }
      const accum = state._toolCallAccum[idx];
      if (tc.id) accum.id = tc.id;
      if (tc.function?.name) accum.name += tc.function.name;
      if (tc.function?.arguments) accum.arguments += tc.function.arguments;
    }
    // Skip emit — wait for finish_reason
    if (parts.length === 0 && !finishReason) return null;
  }

  // On finish, emit accumulated tool calls as complete functionCall parts
  if (finishReason) {
    const indices = Object.keys(state._toolCallAccum);
    for (const idx of indices) {
      const accum = state._toolCallAccum[idx];
      let args = {};
      try { args = JSON.parse(accum.arguments); } catch { /* empty */ }
      // Restore original tool name if it was prefixed during cloaking
      const originalName = state.toolNameMap?.get(accum.name) || accum.name;
      parts.push({
        functionCall: {
          name: originalName,
          args
        }
      });
    }
  }

  // Skip empty non-finish chunks
  if (parts.length === 0 && !finishReason) return null;

  // Ensure at least empty text part on finish with no content
  if (parts.length === 0 && finishReason) {
    parts.push({ text: "" });
  }

  // Build candidate
  const candidate = { content: { role: "model", parts } };

  // Finish reason mapping
  if (finishReason) {
    const reasonMap = {
      "stop": "STOP",
      "length": "MAX_TOKENS",
      "tool_calls": "STOP",
      "content_filter": "SAFETY"
    };
    candidate.finishReason = reasonMap[finishReason] || "STOP";
  }

  // Build Gemini response (no outer "response" wrapper — that's Antigravity-specific)
  const result = {
    candidates: [candidate],
    modelVersion: state._modelVersion,
    responseId: state._responseId
  };

  // Usage metadata
  const usage = chunk.usage || state._usage;
  if (usage) {
    result.usageMetadata = {
      promptTokenCount: usage.prompt_tokens || 0,
      candidatesTokenCount: usage.completion_tokens || 0,
      totalTokenCount: usage.total_tokens || 0
    };
    if (usage.completion_tokens_details?.reasoning_tokens) {
      result.usageMetadata.thoughtsTokenCount = usage.completion_tokens_details.reasoning_tokens;
    }
    if (usage.prompt_tokens_details?.cached_tokens) {
      result.usageMetadata.cachedContentTokenCount = usage.prompt_tokens_details.cached_tokens;
    }
  }

  return result;
}

// Register for GEMINI and GEMINI_CLI source formats
register(FORMATS.OPENAI, FORMATS.GEMINI, null, openaiToGeminiResponse);
register(FORMATS.OPENAI, FORMATS.GEMINI_CLI, null, openaiToGeminiResponse);
