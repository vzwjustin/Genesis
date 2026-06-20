import { convertResponsesStreamToJson } from "../../transformer/streamToJsonConverter.js";
import { createErrorResult, PROXY_INTERNAL_ERROR_CODES } from "../../utils/error.js";

const PROXY_INTERNAL_SSE = {
  // Client-facing alias (Req 6.6): expose error.type = "stream_assembly_failed" while
  // keeping the internal error.code = "sse_assembly_failed" (PROXY_INTERNAL_ERROR_CODES)
  // unchanged for combo/fallback gating. Alias-only at the response boundary — see
  // design.md "Open Questions — RESOLVED", Decision 2.
  errorType: "stream_assembly_failed",
  errorCode: PROXY_INTERNAL_ERROR_CODES.SSE_ASSEMBLY_FAILED,
  proxyInternal: true,
};
import { HTTP_STATUS } from "../../config/runtimeConfig.js";
import { FORMATS } from "../../translator/formats.js";
import { readCappedResponseText } from "../../utils/stream.js";
import { buildRequestDetail, extractRequestConfig, saveUsageStats } from "./requestDetail.js";
import { saveRequestDetail, appendRequestLog } from "@/lib/usageDb.js";
import { convertCommandCodeToOpenAI } from "../../translator/response/commandcode-to-openai.js";

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

// Accounting/usage bookkeeping must never fail an already-successful response.
// Each call site sits inside a try whose catch returns BAD_GATEWAY — without
// this isolation a throw would turn a delivered 200 into a 502.
async function runOnRequestSuccess(onRequestSuccess) {
  if (!onRequestSuccess) return;
  try {
    await onRequestSuccess();
  } catch (err) {
    console.error("[ChatCore] onRequestSuccess threw after a successful response (ignored):", err?.message || err);
  }
}

function appendCapped(existing, addition) {
  const cur = existing || "";
  const next = cur + (addition || "");
  if (next.length > MAX_BLOCK_CHARS) {
    throw new BlockSizeExceededError("content block exceeded MAX_BLOCK_CHARS");
  }
  return next;
}

/** Tool names are usually streamed as deltas; some providers resend the full name each chunk. */
function mergeToolNameDelta(existing, incoming) {
  const cur = existing || "";
  const next = incoming || "";
  if (!next) return cur;
  if (!cur || next === cur) return next;
  if (next.startsWith(cur)) return next;
  if (cur.startsWith(next)) return cur;
  return appendCapped(cur, next);
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

function parseToolArguments(argsJson) {
  try {
    return JSON.parse(argsJson || "{}");
  } catch {
    return null;
  }
}

function openAIChatCompletionToClaude(openaiResponse) {
  const choice = openaiResponse.choices?.[0];
  if (!choice) return openaiResponse;

  const msg = choice.message || {};
  const content = [];
  if (msg.reasoning_content) content.push({ type: "thinking", thinking: msg.reasoning_content });
  if (msg.content) content.push({ type: "text", text: msg.content });
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      const input = parseToolArguments(tc.function?.arguments);
      if (input === null) return null;
      content.push({
        type: "tool_use",
        id: tc.id || `toolu_${Date.now()}`,
        name: tc.function?.name || "",
        input,
      });
    }
  }
  if (content.length === 0) content.push({ type: "text", text: "" });

  let stopReason = "end_turn";
  if (choice.finish_reason === "tool_calls") stopReason = "tool_use";
  else if (choice.finish_reason === "length") stopReason = "max_tokens";

  const result = {
    id: openaiResponse.id?.replace("chatcmpl-", "msg_") || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: openaiResponse.model || "unknown",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
  };
  if (openaiResponse.usage) {
    result.usage = {
      input_tokens: openaiResponse.usage.prompt_tokens || 0,
      output_tokens: openaiResponse.usage.completion_tokens || 0,
    };
    if (openaiResponse.usage.prompt_tokens_details?.cached_tokens) {
      result.usage.cache_read_input_tokens = openaiResponse.usage.prompt_tokens_details.cached_tokens;
    }
  }
  return result;
}

function openAIChatCompletionToGemini(openaiResponse, wrapAntigravity = false) {
  const choice = openaiResponse.choices?.[0];
  if (!choice) return openaiResponse;

  const msg = choice.message || {};
  const parts = [];
  if (msg.reasoning_content) parts.push({ thought: true, text: msg.reasoning_content });
  if (msg.content) parts.push({ text: msg.content });
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      const args = parseToolArguments(tc.function?.arguments);
      if (args === null) return null;
      parts.push({ functionCall: { name: tc.function?.name || "", args } });
    }
  }
  if (parts.length === 0) parts.push({ text: "" });

  let finishReason = "STOP";
  if (choice.finish_reason === "length") finishReason = "MAX_TOKENS";
  else if (choice.finish_reason === "content_filter") finishReason = "SAFETY";

  const geminiBody = {
    candidates: [{ content: { role: "model", parts }, finishReason }],
    modelVersion: openaiResponse.model || "unknown",
    responseId: openaiResponse.id || `resp_${Date.now()}`,
  };
  if (openaiResponse.usage) {
    geminiBody.usageMetadata = {
      promptTokenCount: openaiResponse.usage.prompt_tokens || 0,
      candidatesTokenCount: openaiResponse.usage.completion_tokens || 0,
      totalTokenCount: openaiResponse.usage.total_tokens || 0,
    };
    if (openaiResponse.usage.completion_tokens_details?.reasoning_tokens) {
      geminiBody.usageMetadata.thoughtsTokenCount = openaiResponse.usage.completion_tokens_details.reasoning_tokens;
    }
    if (openaiResponse.usage.prompt_tokens_details?.cached_tokens) {
      geminiBody.usageMetadata.cachedContentTokenCount = openaiResponse.usage.prompt_tokens_details.cached_tokens;
    }
  }
  return wrapAntigravity ? { response: geminiBody } : geminiBody;
}

function convertOpenAIChatCompletionToSource(openaiResponse, sourceFormat) {
  if (sourceFormat === FORMATS.OPENAI) return openaiResponse;
  if (sourceFormat === FORMATS.OPENAI_RESPONSES) return openAIChatCompletionToResponsesJson(openaiResponse);
  if (sourceFormat === FORMATS.CLAUDE) return openAIChatCompletionToClaude(openaiResponse);
  if (sourceFormat === FORMATS.GEMINI || sourceFormat === FORMATS.GEMINI_CLI) {
    return openAIChatCompletionToGemini(openaiResponse, false);
  }
  if (sourceFormat === FORMATS.ANTIGRAVITY) {
    return openAIChatCompletionToGemini(openaiResponse, true);
  }
  return openaiResponse;
}

// Split raw SSE text into payload strings, one per event. Per the SSE spec an
// event is delimited by a blank line and may carry multiple `data:` lines that
// are concatenated with "\n". Splitting on bare "\n" and parsing each data line
// independently feeds JSON fragments to JSON.parse and falsely discards valid,
// spec-legal multi-line events.
function extractSSEDataPayloads(rawSSE) {
  const payloads = [];
  const events = String(rawSSE || "").split(/\r?\n\r?\n/);
  const isCompleteJsonPayload = (line) => {
    if (line === "[DONE]") return true;
    try {
      JSON.parse(line);
      return true;
    } catch {
      return false;
    }
  };
  for (const evt of events) {
    const dataLines = [];
    for (const line of evt.split(/\r?\n/)) {
      const m = line.match(/^data:\s?(.*)$/);
      if (m) dataLines.push(m[1]);
    }
    if (dataLines.length === 0) continue;
    const trimmedLines = dataLines.map((line) => line.trim()).filter(Boolean);
    const linePerPayload =
      trimmedLines.length > 1 &&
      trimmedLines.every(isCompleteJsonPayload);
    if (linePerPayload) {
      payloads.push(...trimmedLines);
    } else {
      payloads.push(dataLines.join("\n").trim());
    }
  }
  return payloads;
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
  for (const payload of extractSSEDataPayloads(rawSSE)) {
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
        // Log upstream error detail before failing closed so it is visible in
        // server logs and not silently swallowed as a generic 502.
        console.warn("[SSE] parseSSEToClaudeResponse: upstream error event received:",
          ev.error?.type || "unknown", "|", ev.error?.message || "(no message)");
        return null;
      default:
        break;
    }
  }
  } catch (e) {
    // Fail closed on block-size overflow rather than returning a truncated body.
    if (e instanceof BlockSizeExceededError) {
      console.warn("[SSE] parseSSEToClaudeResponse: content block exceeded MAX_BLOCK_CHARS limit; returning null to fail closed");
      return null;
    }
    throw e;
  }

  if (openBlocks.size > 0) return null;

  if (invalidToolJson) return null;
  if (!message) return null;
  if (!sawMessageStop) return null;
  if (!sawContent) return null;

  if (stopReason) message.stop_reason = stopReason;
  if (stopSequence !== undefined) message.stop_sequence = stopSequence;
  // Merge, don't overwrite: message_start carries input_tokens (+cache_* fields)
  // while message_delta.usage carries only output_tokens. Overwriting would drop
  // input_tokens → undercounted prompt tokens in usage stats / billing.
  if (usage) message.usage = { ...message.usage, ...usage };
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
        last.text = appendCapped(last.text, part.text);
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

  for (const payload of extractSSEDataPayloads(rawSSE)) {
    if (!payload) continue;
    if (payload === "[DONE]") {
      sawTerminal = true;
      continue;
    }
    try {
      const parsed = JSON.parse(payload);
      if (parsed && parsed.error) {
        console.warn("[SSE] parseSSEToGeminiResponse: upstream error event received:",
          parsed.error?.status || parsed.error?.code || "unknown", "|", parsed.error?.message || "(no message)");
        return null;
      }
      chunks.push(parsed);
    } catch {
      return null;
    }
  }

  if (chunks.length === 0) return null;

  let mergedCandidate = null;
  let usageMetadata = null;
  let modelVersion = null;
  let responseId = null;

  try {
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
  } catch (e) {
    if (e instanceof BlockSizeExceededError) return null;
    throw e;
  }

  if (!mergedCandidate) return null;
  if (!mergedCandidate.finishReason) return null;

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

  for (const payload of extractSSEDataPayloads(rawSSE)) {
    if (!payload) continue;
    if (payload === "[DONE]") { sawTerminal = true; continue; }
    try {
      const parsed = JSON.parse(payload);
      // Fail closed on an upstream error frame: a mid-stream `data: {error}`
      // (valid JSON, no `choices`) would otherwise be silently ignored and the
      // partial/empty content returned as success. Mirrors the Claude parser's
      // `case "error"` handling.
      if (parsed && (parsed.error || parsed.type === "error" || parsed.status === "failed" || parsed.response?.error || parsed.response?.status === "failed")) {
        console.warn("[SSE] parseSSEToOpenAIResponse: upstream error event received:",
          parsed.error?.type || parsed.error?.code || parsed.type || parsed.status || parsed.response?.status || "unknown", "|",
          parsed.error?.message || parsed.message || parsed.response?.error?.message || "(no message)");
        return null;
      }
      chunks.push(parsed);
    } catch {
      // Fail closed: a malformed frame means the assembled message would be
      // incomplete. Discard the whole response rather than return a silently
      // truncated body (Requirement 6.6).
      return null;
    }
  }

  if (chunks.length === 0) return null;

  const first = chunks[0];
  let contentJoined = "";
  let reasoningJoined = "";
  const toolCallMap = new Map(); // index -> { id, type, function: { name, arguments } }
  let finishReason = "stop";
  let usage = null;

  try {
  for (const chunk of chunks) {
    const choice = chunk?.choices?.[0];
    const delta = choice?.delta || {};
    if (typeof delta.content === "string" && delta.content.length > 0) {
      contentJoined = appendCapped(contentJoined, delta.content);
    }
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
      reasoningJoined = appendCapped(reasoningJoined, delta.reasoning_content);
    }
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
        if (tc.function?.name) existing.function.name = mergeToolNameDelta(existing.function.name, tc.function.name);
        if (tc.function?.arguments) existing.function.arguments = appendCapped(existing.function.arguments, tc.function.arguments);
      }
    }
  }
  } catch (e) {
    if (e instanceof BlockSizeExceededError) return null;
    throw e;
  }

  // Fail closed: stream never signalled completion (no finish_reason, no [DONE]).
  // Includes role-only chunks that would otherwise fabricate an empty "stop" response.
  if (!sawTerminal && chunks.length > 0) {
    return null;
  }

  const message = { role: "assistant", content: contentJoined || (toolCallMap.size > 0 ? null : "") };
  if (reasoningJoined.length > 0) message.reasoning_content = reasoningJoined;
  if (toolCallMap.size > 0) {
    message.tool_calls = [...toolCallMap.entries()].sort((a, b) => a[0] - b[0]).map(([, tc]) => tc);
    // Fail closed if any accumulated tool-call arguments are not complete JSON:
    // a truncated tool call must not be delivered as success (mirrors the Claude
    // parser's invalid-tool-JSON handling).
    for (const tc of message.tool_calls) {
      const args = tc.function?.arguments;
      if (args === undefined || args === "") continue; // no-argument call
      if (typeof args === "object") continue;
      try { JSON.parse(args); } catch { return null; }
    }
    // Correct finish_reason for tool_calls: a provider may accumulate tool_call
    // deltas and terminate via a bare [DONE] sentinel without ever setting a
    // choice.finish_reason, leaving the default "stop". Clients that gate tool
    // execution on finish_reason === "tool_calls" would otherwise drop the call.
    // Mirrors nonStreamingHandler.js's tool_calls finish_reason correction.
    // Preserve a provider-signalled truncation reason (length / content_filter)
    // so a cut-off tool call stays visible to the client.
    if (finishReason !== "tool_calls" && finishReason !== "length" && finishReason !== "content_filter") {
      finishReason = "tool_calls";
    }
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

function openAIChatCompletionToResponsesJson(openaiResponse) {
  const choice = openaiResponse?.choices?.[0] || {};
  const message = choice.message || {};
  const output = [];
  const responseId = openaiResponse?.id ? `resp_${openaiResponse.id}` : `resp_${Date.now()}`;

  if (message.reasoning_content) {
    output.push({
      id: `rs_${responseId}_0`,
      type: "reasoning",
      summary: [{ type: "summary_text", text: message.reasoning_content }]
    });
  }

  if (Array.isArray(message.tool_calls)) {
    for (const toolCall of message.tool_calls) {
      output.push({
        id: `fc_${toolCall.id || Date.now()}`,
        type: "function_call",
        call_id: toolCall.id || `call_${Date.now()}`,
        name: toolCall.function?.name || "",
        arguments: toolCall.function?.arguments || "{}"
      });
    }
  }

  if (typeof message.content === "string") {
    output.push({
      id: `msg_${responseId}_0`,
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", annotations: [], logprobs: [], text: message.content }]
    });
  }

  const usage = openaiResponse?.usage || {};
  return {
    id: responseId,
    object: "response",
    created_at: openaiResponse?.created || Math.floor(Date.now() / 1000),
    status: "completed",
    output,
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
      total_tokens: usage.total_tokens || ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0))
    }
  };
}

function providerRequestLooksLikeResponsesApi(providerRequest) {
  return Boolean(
    providerRequest &&
    typeof providerRequest === "object" &&
    !Array.isArray(providerRequest) &&
    !Array.isArray(providerRequest.messages) &&
    (Object.prototype.hasOwnProperty.call(providerRequest, "input") ||
      Object.prototype.hasOwnProperty.call(providerRequest, "instructions"))
  );
}

/** Read only the first chunk of a cloned body to detect JSON without buffering SSE streams. */
async function peekResponseStartsWithJson(providerResponse) {
  try {
    const reader = providerResponse.clone().body?.getReader();
    if (!reader) return false;
    const { value, done } = await reader.read();
    try { await reader.cancel(); } catch { /* ignore */ }
    if (done || !value?.length) return false;
    const trimmed = new TextDecoder().decode(value).trimStart();
    return trimmed.startsWith("{") || trimmed.startsWith("[");
  } catch {
    return false;
  }
}

/**
 * Assemble CommandCode AI-SDK SSE events ({type:"text-delta"}, {type:"finish"}, ...)
 * into a single OpenAI chat.completion. CommandCode is always-streaming, so a
 * non-streaming client routes here; the generic OpenAI assembler cannot parse
 * CommandCode frames. Convert each event with the registered translator, then
 * reuse parseSSEToOpenAIResponse so truncated streams (no terminal finish) and
 * upstream error frames still fail closed.
 */
function parseCommandCodeSSEToOpenAI(rawSSE, model) {
  const ccState = {};
  const openaiFrames = [];
  for (const payload of extractSSEDataPayloads(rawSSE)) {
    if (!payload || payload === "[DONE]") continue;
    const out = convertCommandCodeToOpenAI(payload, ccState);
    if (!out) continue;
    for (const chunk of (Array.isArray(out) ? out : [out])) {
      openaiFrames.push(`data: ${JSON.stringify(chunk)}\n\n`);
    }
  }
  if (openaiFrames.length === 0) return null;
  return parseSSEToOpenAIResponse(openaiFrames.join(""), model);
}

export async function handleForcedSSEToJson({ providerResponse, sourceFormat, targetFormat, provider, model, body, stream, translatedBody, finalBody, requestStartTime, connectionId, apiKey, clientRawRequest, onRequestSuccess, trackDone, appendLog, passthrough }) {
  const contentType = readResponseHeader(providerResponse.headers, "content-type");
  const isExplicitSSE = contentType.includes("text/event-stream");
  const isCodexEmptyType = contentType === "" && provider === "codex" && providerResponse.ok;
  if (isCodexEmptyType && await peekResponseStartsWithJson(providerResponse)) {
    return null;
  }
  const isSSE = isExplicitSSE || isCodexEmptyType;
  if (!isSSE) return null; // not handled here

  try {
  const ctx = {
    provider, model, connectionId,
    request: extractRequestConfig(body, stream),
    providerRequest: finalBody || translatedBody || null
  };
  const finalizeFailure = (message, status = HTTP_STATUS.BAD_GATEWAY) => {
    try {
      appendLog({ status: `FAILED ${status}` });
      saveRequestDetail(buildRequestDetail({
        ...ctx,
        latency: { ttft: 0, total: Date.now() - requestStartTime },
        tokens: { prompt_tokens: 0, completion_tokens: 0 },
        response: { error: message, status, thinking: null },
        status: "error"
      }, { endpoint: clientRawRequest?.endpoint || null })).catch(() => {});
    } catch {
      // Failure persistence is diagnostic only and must not alter the client response.
    }
  };

  // Responses API SSE path. Key this off the upstream target response shape,
  // not the client source format: /v1/responses can be translated to OpenAI
  // Chat Completions upstream, whose SSE frames must use the OpenAI parser.
  const providerRequest = finalBody || translatedBody || null;
  const isResponsesApiSSE =
    provider === "codex" ||
    targetFormat === FORMATS.OPENAI_RESPONSES ||
    providerRequestLooksLikeResponsesApi(providerRequest);
  if (isResponsesApiSSE) {
    try {
      const sseText = await readCappedResponseText(providerResponse);
      if (sseText === null) {
        finalizeFailure("SSE response exceeds size limit for non-streaming request");
        return createErrorResult(HTTP_STATUS.BAD_GATEWAY, "SSE response exceeds size limit for non-streaming request", undefined, PROXY_INTERNAL_SSE);
      }
      const cappedBody = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseText));
          controller.close();
        },
      });
      const jsonResponse = await convertResponsesStreamToJson(cappedBody);

      // Fail closed: a stream that never reached "completed" is truncated or failed.
      // Discard the partial assembly and return an error — never emit partial JSON as success.
      if (jsonResponse.status !== "completed") {
        finalizeFailure("Incomplete streaming response");
        return createErrorResult(HTTP_STATUS.BAD_GATEWAY, "Incomplete streaming response", undefined, PROXY_INTERNAL_SSE);
      }

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
        await runOnRequestSuccess(onRequestSuccess);
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
            try { args = JSON.parse(args); } catch { throw new Error("Invalid Responses API function-call arguments"); }
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
      } else if (sourceFormat === FORMATS.CLAUDE) {
        finalResp = convertOpenAIChatCompletionToSource({
          id: jsonResponse.id || `chatcmpl-${Date.now()}`,
          object: "chat.completion",
          created: jsonResponse.created_at || Math.floor(Date.now() / 1000),
          model: jsonResponse.model || model,
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: textContent || (hasToolCalls ? null : ""),
              ...(hasToolCalls ? { tool_calls: toolCalls } : {}),
            },
            finish_reason: hasToolCalls ? "tool_calls" : (jsonResponse.status === "completed" ? "stop" : (jsonResponse.status || "stop")),
          }],
          usage: { prompt_tokens: inTokens, completion_tokens: outTokens, total_tokens: inTokens + outTokens },
        }, sourceFormat);
        if (!finalResp) throw new Error("Invalid Responses API function-call arguments");
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

      await runOnRequestSuccess(onRequestSuccess);
      return { success: true, response: new Response(JSON.stringify(finalResp), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }) };
    } catch (err) {
      console.error("[ChatCore] Responses API SSE→JSON failed:", err);
      finalizeFailure("Failed to convert streaming response to JSON");
      return createErrorResult(HTTP_STATUS.BAD_GATEWAY, "Failed to convert streaming response to JSON", undefined, PROXY_INTERNAL_SSE);
    }
  }

  // Standard Chat Completions SSE path
  try {
    // Cap the read: an unbounded upstream (or a malicious MITM) could otherwise stream
    // an arbitrarily large body into memory before assembly. Mirrors the sibling guard in
    // nonStreamingHandler.js. Fail closed (BAD_GATEWAY) rather than buffer without limit.
    const sseText = await readCappedResponseText(providerResponse);
    if (sseText === null) {
      finalizeFailure("SSE response exceeds size limit for non-streaming request");
      return createErrorResult(HTTP_STATUS.BAD_GATEWAY, "SSE response exceeds size limit for non-streaming request", undefined, PROXY_INTERNAL_SSE);
    }
    let parsed = passthrough
      ? await parseSSEToNativeResponse(sseText, sourceFormat, model)
      : (targetFormat === FORMATS.COMMANDCODE
          ? parseCommandCodeSSEToOpenAI(sseText, model)
          : parseSSEToOpenAIResponse(sseText, model));
    if (!parsed) {
      finalizeFailure("Invalid SSE response for non-streaming request");
      return createErrorResult(HTTP_STATUS.BAD_GATEWAY, "Invalid SSE response for non-streaming request", undefined, PROXY_INTERNAL_SSE);
    }
    if (!passthrough) {
      parsed = convertOpenAIChatCompletionToSource(parsed, sourceFormat);
      if (!parsed) {
        finalizeFailure("Invalid SSE response for non-streaming request");
        return createErrorResult(HTTP_STATUS.BAD_GATEWAY, "Invalid SSE response for non-streaming request", undefined, PROXY_INTERNAL_SSE);
      }
    }

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
            content: parsed.choices?.[0]?.message?.content || textFromResponsesMessageItem(parsed.output?.find((item) => item.type === "message")) || null,
            thinking: parsed.choices?.[0]?.message?.reasoning_content || null,
            finish_reason: parsed.choices?.[0]?.finish_reason || (parsed.status === "completed" ? "stop" : "unknown"),
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

    await runOnRequestSuccess(onRequestSuccess);
    return { success: true, response: new Response(JSON.stringify(parsed), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }) };
  } catch (err) {
    console.error("[ChatCore] Chat Completions SSE→JSON failed:", err);
    finalizeFailure("Failed to convert streaming response to JSON");
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, "Failed to convert streaming response to JSON", undefined, PROXY_INTERNAL_SSE);
  }
  } finally {
    trackDone();
  }
}
