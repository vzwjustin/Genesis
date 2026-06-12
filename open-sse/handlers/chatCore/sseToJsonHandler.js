import { convertResponsesStreamToJson } from "../../transformer/streamToJsonConverter.js";
import { createErrorResult, PROXY_INTERNAL_ERROR_CODES } from "../../utils/error.js";

const PROXY_INTERNAL_SSE = {
  errorCode: PROXY_INTERNAL_ERROR_CODES.SSE_ASSEMBLY_FAILED,
  proxyInternal: true,
};
import { HTTP_STATUS } from "../../config/runtimeConfig.js";
import { FORMATS } from "../../translator/formats.js";
import { buildRequestDetail, extractRequestConfig, saveUsageStats } from "./requestDetail.js";
import { saveRequestDetail, appendRequestLog } from "@/lib/usageDb.js";

// Upper bound on a single content block's accumulated text/thinking/JSON.
// A compromised or MITM upstream could otherwise stream unbounded deltas into
// one block and exhaust memory before assembly completes. 64 MiB is far above
// any legitimate single-block response.
const MAX_BLOCK_CHARS = 64 * 1024 * 1024;

// Sentinel thrown when a block exceeds the cap. Callers catch this and fail
// closed (return null) rather than emit a silently-truncated success — a
// truncated body would violate the same response-validity rule as a malformed
// frame (Requirement 6.6).
class BlockSizeExceededError extends Error {}

function appendCapped(existing, addition) {
  const cur = existing || "";
  const next = cur + (addition || "");
  if (next.length > MAX_BLOCK_CHARS) {
    throw new BlockSizeExceededError("content block exceeded MAX_BLOCK_CHARS");
  }
  return next;
}

function textFromResponsesMessageItem(item) {
  if (!item?.content || !Array.isArray(item.content)) return "";
  const byType = item.content.find((c) => c.type === "output_text");
  if (typeof byType?.text === "string") return byType.text;
  const anyText = item.content.find((c) => typeof c.text === "string");
  if (typeof anyText?.text === "string") return anyText.text;
  return "";
}

/**
 * Codex / Responses API may emit many alternating reasoning + message items.
 * Early message blocks often have empty output_text; the user-visible answer is usually in the last non-empty message.
 */
function pickAssistantMessageForChatCompletion(output) {
  if (!Array.isArray(output)) return { msgItem: null, textContent: null };
  const messages = output.filter((item) => item?.type === "message");
  if (messages.length === 0) return { msgItem: null, textContent: null };
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = textFromResponsesMessageItem(messages[i]);
    if (text.length > 0) return { msgItem: messages[i], textContent: text };
  }
  const last = messages[messages.length - 1];
  return { msgItem: last, textContent: textFromResponsesMessageItem(last) };
}

function sseTextToStream(rawSSE) {
  const bytes = new TextEncoder().encode(String(rawSSE || ""));
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/**
 * Assemble Anthropic Messages API SSE into a single message JSON object.
 */
export function parseSSEToClaudeResponse(rawSSE) {
  const events = [];
  for (const line of String(rawSSE || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      events.push(JSON.parse(payload));
    } catch {
      // Fail closed: a malformed frame means the assembled message would be
      // incomplete. Discard the whole response rather than return a silently
      // truncated body (Requirement 6.6).
      return null;
    }
  }

  if (events.length === 0) return null;

  let message = null;
  const openBlocks = new Map();
  let stopReason = null;
  let stopSequence = null;
  let usage = null;
  let sawMessageStop = false;
  let sawContent = false;
  let invalidToolJson = false;

  const finalizeBlock = (index) => {
    const block = openBlocks.get(index);
    if (!block) return;
    if (block._partialJson) {
      try {
        block.input = JSON.parse(block._partialJson);
      } catch {
        invalidToolJson = true;
        return;
      }
      delete block._partialJson;
    }
    if (!message) message = { type: "message", role: "assistant", content: [] };
    message.content.push(block);
    openBlocks.delete(index);
    sawContent = true;
  };

  try {
  for (const ev of events) {
    switch (ev.type) {
      case "message_start":
        message = { ...ev.message, content: [] };
        break;
      case "content_block_start": {
        const block = { ...ev.content_block };
        if (block.type === "text") block.text = "";
        if (block.type === "thinking") block.thinking = "";
        if (block.type === "tool_use") block.input = block.input || {};
        openBlocks.set(ev.index, block);
        break;
      }
      case "content_block_delta": {
        const block = openBlocks.get(ev.index);
        if (!block || !ev.delta) break;
        if (ev.delta.type === "text_delta") {
          block.text = appendCapped(block.text, ev.delta.text);
        } else if (ev.delta.type === "thinking_delta") {
          block.thinking = appendCapped(block.thinking, ev.delta.thinking);
        } else if (ev.delta.type === "input_json_delta") {
          block._partialJson = appendCapped(block._partialJson, ev.delta.partial_json);
        }
        break;
      }
      case "content_block_stop":
        finalizeBlock(ev.index);
        break;
      case "message_delta":
        if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
        if (ev.delta?.stop_sequence !== undefined) stopSequence = ev.delta.stop_sequence;
        if (ev.usage) usage = ev.usage;
        break;
      case "message_stop":
        sawMessageStop = true;
        break;
      case "error":
        return null;
      default:
        break;
    }
  }
  } catch (e) {
    // Fail closed on block-size overflow rather than returning a truncated body.
    if (e instanceof BlockSizeExceededError) return null;
    throw e;
  }

  if (openBlocks.size > 0) return null;

  if (invalidToolJson) return null;
  if (!message) return null;
  if (!sawMessageStop) return null;

  if (stopReason) message.stop_reason = stopReason;
  if (stopSequence !== undefined) message.stop_sequence = stopSequence;
  if (usage) message.usage = usage;
  return message;
}

function unwrapGeminiStreamChunk(chunk) {
  if (!chunk || typeof chunk !== "object") return null;
  return chunk.response && typeof chunk.response === "object" ? chunk.response : chunk;
}

function functionCallDedupeKey(functionCall) {
  if (!functionCall || typeof functionCall !== "object") return "";
  const id = functionCall.id || "";
  if (id) return `id:${id}`;
  const name = functionCall.name || "";
  const args = JSON.stringify(functionCall.args || {});
  return `name:${name}:${args}`;
}

function mergeGeminiParts(existingParts, incomingParts) {
  const parts = [...existingParts];
  const seenFunctionCalls = new Set(
    parts.filter((p) => p.functionCall).map((p) => functionCallDedupeKey(p.functionCall))
  );

  for (const part of incomingParts) {
    if (typeof part.text === "string") {
      const last = parts[parts.length - 1];
      if (last && typeof last.text === "string" && !last.thought && !part.thought) {
        last.text += part.text;
      } else {
        parts.push({ ...part });
      }
      continue;
    }
    if (part.functionCall) {
      const key = functionCallDedupeKey(part.functionCall);
      if (key && seenFunctionCalls.has(key)) continue;
      if (key) seenFunctionCalls.add(key);
      parts.push({ functionCall: { ...part.functionCall } });
    }
  }
  return parts;
}

/**
 * Assemble Gemini / Antigravity native SSE into a single JSON object.
 */
export function parseSSEToGeminiResponse(rawSSE, wrapInResponse = false) {
  const chunks = [];
  let sawTerminal = false;

  for (const line of String(rawSSE || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload) continue;
    if (payload === "[DONE]") {
      sawTerminal = true;
      continue;
    }
    try {
      chunks.push(JSON.parse(payload));
    } catch {
      return null;
    }
  }

  if (chunks.length === 0) return null;

  let mergedCandidate = null;
  let usageMetadata = null;
  let modelVersion = null;
  let responseId = null;

  for (const chunk of chunks) {
    const body = unwrapGeminiStreamChunk(chunk);
    if (!body) continue;
    if (body.modelVersion) modelVersion = body.modelVersion;
    if (body.responseId) responseId = body.responseId;
    if (body.usageMetadata && typeof body.usageMetadata === "object") {
      usageMetadata = { ...(usageMetadata || {}), ...body.usageMetadata };
    }

    const candidate = body.candidates?.[0];
    if (!candidate) continue;
    if (candidate.finishReason) sawTerminal = true;

    if (!mergedCandidate) {
      mergedCandidate = {
        ...candidate,
        content: candidate.content
          ? { ...candidate.content, parts: [...(candidate.content.parts || [])] }
          : { role: "model", parts: [] },
      };
      continue;
    }

    const incomingParts = candidate.content?.parts || [];
    const existingParts = mergedCandidate.content?.parts || [];
    mergedCandidate.content = {
      role: mergedCandidate.content?.role || candidate.content?.role || "model",
      parts: mergeGeminiParts(existingParts, incomingParts),
    };
    if (candidate.finishReason) mergedCandidate.finishReason = candidate.finishReason;
    if (candidate.index !== undefined) mergedCandidate.index = candidate.index;
  }

  if (!mergedCandidate) return null;
  if (!sawTerminal && !mergedCandidate.finishReason) return null;

  const result = {
    candidates: [mergedCandidate],
    modelVersion: modelVersion || "unknown",
    responseId: responseId || `resp_${Date.now()}`,
  };
  if (usageMetadata) result.usageMetadata = usageMetadata;

  return wrapInResponse ? { response: result } : result;
}

/**
 * Assemble SSE into the client's native response format for passthrough mode.
 */
export async function parseSSEToNativeResponse(rawSSE, sourceFormat, fallbackModel) {
  if (sourceFormat === FORMATS.CLAUDE) {
    return parseSSEToClaudeResponse(rawSSE);
  }
  if (sourceFormat === FORMATS.OPENAI_RESPONSES) {
    const jsonResponse = await convertResponsesStreamToJson(sseTextToStream(rawSSE));
    if (jsonResponse.status !== "completed") return null;
    return jsonResponse;
  }
  if (sourceFormat === FORMATS.GEMINI || sourceFormat === FORMATS.GEMINI_CLI) {
    return parseSSEToGeminiResponse(rawSSE, false);
  }
  if (sourceFormat === FORMATS.ANTIGRAVITY) {
    return parseSSEToGeminiResponse(rawSSE, true);
  }
  return parseSSEToOpenAIResponse(rawSSE, fallbackModel);
}

/**
 * Parse OpenAI-style SSE text into a single chat completion JSON.
 * Used when provider forces streaming but client wants non-streaming.
 */
export function parseSSEToOpenAIResponse(rawSSE, fallbackModel) {
  const chunks = [];
  let sawTerminal = false; // [DONE] sentinel OR a finish_reason marks a complete stream

  for (const line of String(rawSSE || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload) continue;
    if (payload === "[DONE]") { sawTerminal = true; continue; }
    try {
      chunks.push(JSON.parse(payload));
    } catch {
      // Fail closed: a malformed frame means the assembled message would be
      // incomplete. Discard the whole response rather than return a silently
      // truncated body (Requirement 6.6).
      return null;
    }
  }

  if (chunks.length === 0) return null;

  const first = chunks[0];
  const contentParts = [];
  const reasoningParts = [];
  const toolCallMap = new Map(); // index -> { id, type, function: { name, arguments } }
  let finishReason = "stop";
  let usage = null;

  for (const chunk of chunks) {
    const choice = chunk?.choices?.[0];
    const delta = choice?.delta || {};
    if (typeof delta.content === "string" && delta.content.length > 0) contentParts.push(delta.content);
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) reasoningParts.push(delta.reasoning_content);
    if (choice?.finish_reason) { finishReason = choice.finish_reason; sawTerminal = true; }
    if (chunk?.usage && typeof chunk.usage === "object") usage = chunk.usage;

    // Accumulate tool_calls from streaming deltas
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        if (!toolCallMap.has(idx)) {
          toolCallMap.set(idx, { id: tc.id || "", type: "function", function: { name: "", arguments: "" } });
        }
        const existing = toolCallMap.get(idx);
        if (tc.id) existing.id = tc.id;
        if (tc.function?.name) existing.function.name += tc.function.name;
        if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
      }
    }
  }

  // Fail closed: stream never signalled completion (no finish_reason, no [DONE]).
  // Includes role-only chunks that would otherwise fabricate an empty "stop" response.
  if (!sawTerminal && chunks.length > 0) {
    return null;
  }

  const message = { role: "assistant", content: contentParts.join("") || (toolCallMap.size > 0 ? null : "") };
  if (reasoningParts.length > 0) message.reasoning_content = reasoningParts.join("");
  if (toolCallMap.size > 0) {
    message.tool_calls = [...toolCallMap.entries()].sort((a, b) => a[0] - b[0]).map(([, tc]) => tc);
  }

  const result = {
    id: first.id || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: first.created || Math.floor(Date.now() / 1000),
    model: first.model || fallbackModel || "unknown",
    choices: [{ index: 0, message, finish_reason: finishReason }]
  };
  if (usage) result.usage = usage;
  return result;
}

/**
 * Handle case: provider forced streaming but client wants JSON.
 * Supports both Codex/Responses API SSE and standard Chat Completions SSE.
 */
function readResponseHeader(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") return headers.get(name) || "";
  const lower = name.toLowerCase();
  return headers[name] || headers[lower] || "";
}

export async function handleForcedSSEToJson({ providerResponse, sourceFormat, provider, model, body, stream, translatedBody, finalBody, requestStartTime, connectionId, apiKey, clientRawRequest, onRequestSuccess, trackDone, appendLog, passthrough }) {
  const contentType = readResponseHeader(providerResponse.headers, "content-type");
  const isSSE = contentType.includes("text/event-stream") || (contentType === "" && provider === "codex");
  if (!isSSE) return null; // not handled here

  trackDone();

  const ctx = {
    provider, model, connectionId,
    request: extractRequestConfig(body, stream),
    providerRequest: finalBody || translatedBody || null
  };

  // Codex/Responses API SSE path
  const isCodexResponsesApi = provider === "codex" || sourceFormat === FORMATS.OPENAI_RESPONSES;
  if (isCodexResponsesApi) {
    try {
      const jsonResponse = await convertResponsesStreamToJson(providerResponse.body);

      // Fail closed: a stream that never reached "completed" is truncated or failed.
      // Discard the partial assembly and return an error — never emit partial JSON as success.
      if (jsonResponse.status !== "completed") {
        return createErrorResult(HTTP_STATUS.BAD_GATEWAY, "Incomplete streaming response", undefined, PROXY_INTERNAL_SSE);
      }

      if (onRequestSuccess) await onRequestSuccess();

      const usage = jsonResponse.usage || {};
      appendLog({ tokens: usage, status: "200 OK" });
      saveUsageStats({ provider, model, tokens: usage, connectionId, apiKey, endpoint: clientRawRequest?.endpoint });

      const { msgItem, textContent } = pickAssistantMessageForChatCompletion(jsonResponse.output);
      const totalLatency = Date.now() - requestStartTime;
      const hasToolCallsForLog = (jsonResponse.output || []).some((item) => item.type === "function_call");
      const logFinishReason = hasToolCallsForLog
        ? "tool_calls"
        : (jsonResponse.status === "completed" ? "stop" : "unknown");

      saveRequestDetail(buildRequestDetail({
        ...ctx,
        latency: { ttft: totalLatency, total: totalLatency },
        tokens: { prompt_tokens: usage.input_tokens || 0, completion_tokens: usage.output_tokens || 0 },
        response: { content: textContent, thinking: null, finish_reason: logFinishReason },
        status: "success"
      }, { endpoint: clientRawRequest?.endpoint || null })).catch(() => {});

      // Passthrough: preserve native Responses API JSON — do not convert to chat.completion.
      if (passthrough || sourceFormat === FORMATS.OPENAI_RESPONSES) {
        return { success: true, response: new Response(JSON.stringify(jsonResponse), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }) };
      }

      // Build client-format response
      const inTokens = usage.input_tokens || 0;
      const outTokens = usage.output_tokens || 0;
      let finalResp;

      // Extract tool calls from Responses API output (function_call items)
      const funcCallItems = (jsonResponse.output || []).filter(item => item.type === "function_call");
      const toolCalls = funcCallItems.map((item, idx) => ({
        id: item.call_id || `call_${item.name}_${Date.now()}_${idx}`,
        type: "function",
        function: {
          name: item.name,
          arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {})
        }
      }));
      const hasToolCalls = toolCalls.length > 0;

      if (sourceFormat === FORMATS.ANTIGRAVITY || sourceFormat === FORMATS.GEMINI || sourceFormat === FORMATS.GEMINI_CLI) {
        const geminiParts = [];
        if (textContent) geminiParts.push({ text: textContent });
        for (const item of funcCallItems) {
          let args = item.arguments || {};
          if (typeof args === "string") {
            try { args = JSON.parse(args); } catch { args = {}; }
          }
          geminiParts.push({
            functionCall: {
              id: item.call_id || item.id,
              name: item.name,
              args,
            },
          });
        }
        if (geminiParts.length === 0) geminiParts.push({ text: "" });
        const geminiBody = {
          candidates: [{
            content: { role: "model", parts: geminiParts },
            finishReason: "STOP",
            index: 0,
          }],
          usageMetadata: { promptTokenCount: inTokens, candidatesTokenCount: outTokens, totalTokenCount: inTokens + outTokens },
          modelVersion: model,
          responseId: jsonResponse.id || `resp_${Date.now()}`
        };
        // Antigravity wraps in { response: ... }, plain Gemini does not
        finalResp = sourceFormat === FORMATS.ANTIGRAVITY
          ? { response: geminiBody }
          : geminiBody;
      } else {
        const message = { role: "assistant", content: textContent || (hasToolCalls ? null : "") };
        if (hasToolCalls) message.tool_calls = toolCalls;
        const finishReason = hasToolCalls ? "tool_calls" : (jsonResponse.status === "completed" ? "stop" : (jsonResponse.status || "stop"));
        finalResp = {
          id: jsonResponse.id || `chatcmpl-${Date.now()}`,
          object: "chat.completion",
          created: jsonResponse.created_at || Math.floor(Date.now() / 1000),
          model: jsonResponse.model || model,
          choices: [{ index: 0, message, finish_reason: finishReason }],
          usage: { prompt_tokens: inTokens, completion_tokens: outTokens, total_tokens: inTokens + outTokens }
        };
      }

      return { success: true, response: new Response(JSON.stringify(finalResp), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }) };
    } catch (err) {
      console.error("[ChatCore] Responses API SSE→JSON failed:", err);
      return createErrorResult(HTTP_STATUS.BAD_GATEWAY, "Failed to convert streaming response to JSON", undefined, PROXY_INTERNAL_SSE);
    }
  }

  // Standard Chat Completions SSE path
  try {
    const sseText = await providerResponse.text();
    const parsed = passthrough
      ? await parseSSEToNativeResponse(sseText, sourceFormat, model)
      : parseSSEToOpenAIResponse(sseText, model);
    if (!parsed) return createErrorResult(HTTP_STATUS.BAD_GATEWAY, "Invalid SSE response for non-streaming request", undefined, PROXY_INTERNAL_SSE);

    if (onRequestSuccess) await onRequestSuccess();

    const usage = parsed.usage || {};
    appendLog({ tokens: usage, status: "200 OK" });
    saveUsageStats({ provider, model, tokens: usage, connectionId, apiKey, endpoint: clientRawRequest?.endpoint });

    const totalLatency = Date.now() - requestStartTime;
    const isClaudeNative = passthrough && sourceFormat === FORMATS.CLAUDE;
    const textFromClaudeContent = (content) => {
      if (!Array.isArray(content)) return null;
      return content
        .filter((block) => block?.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("") || null;
    };
    const thinkingFromClaudeContent = (content) => {
      if (!Array.isArray(content)) return null;
      return content
        .filter((block) => block?.type === "thinking" && typeof block.thinking === "string")
        .map((block) => block.thinking)
        .join("") || null;
    };
    saveRequestDetail(buildRequestDetail({
      ...ctx,
      latency: { ttft: totalLatency, total: totalLatency },
      tokens: usage,
      response: isClaudeNative
        ? {
            content: textFromClaudeContent(parsed.content),
            thinking: thinkingFromClaudeContent(parsed.content),
            finish_reason: parsed.stop_reason || "unknown",
          }
        : {
            content: parsed.choices?.[0]?.message?.content || null,
            thinking: parsed.choices?.[0]?.message?.reasoning_content || null,
            finish_reason: parsed.choices?.[0]?.finish_reason || "unknown",
          },
      status: "success"
    }, { endpoint: clientRawRequest?.endpoint || null })).catch(() => {});

    // Strip reasoning_content only when content is non-empty.
    // When content is empty (e.g. thinking models that used all tokens for reasoning),
    // reasoning_content is the only useful output and must be preserved.
    // Previously this was unconditional, which broke Qwen3.5, Claude extended thinking, etc.
    // PASSTHROUGH GUARD: In passthrough mode, preserve all provider-specific fields including reasoning_content.
    if (!passthrough && parsed?.choices) {
      for (const choice of parsed.choices) {
        if (choice?.message?.reasoning_content && choice.message.content) {
          delete choice.message.reasoning_content;
        }
      }
    }

    return { success: true, response: new Response(JSON.stringify(parsed), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }) };
  } catch (err) {
    console.error("[ChatCore] Chat Completions SSE→JSON failed:", err);
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, "Failed to convert streaming response to JSON", undefined, PROXY_INTERNAL_SSE);
  }
}
