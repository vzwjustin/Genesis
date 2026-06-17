import { FORMATS } from "../translator/formats.js";

export class MalformedSSEDataError extends Error {
  constructor(data) {
    super("Malformed SSE data frame");
    this.name = "MalformedSSEDataError";
    this.data = data;
  }
}

// Parse SSE data line
export function parseSSELine(line, format = null, options = {}) {
  if (!line) return null;

  const trimmed = line.trim();

  // NDJSON / raw JSON lines without "data:" prefix
  if (format === FORMATS.OLLAMA || trimmed.startsWith("{")) {
    if (trimmed.startsWith("{")) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return null;
      }
    }
    if (format === FORMATS.OLLAMA) return null;
  }

  // Standard SSE format: "data: {...}"
  // Test the trimmed line — upstream may indent frames or a buffer split may
  // leave leading whitespace; checking raw `line[0]` would drop valid frames.
  if (!trimmed.startsWith("data:")) return null;

  const data = trimmed.slice(5).trim();
  if (!data) return null;
  if (data === "[DONE]") return { done: true };

  try {
    return JSON.parse(data);
  } catch (error) {
    if (data.length > 0 && data.length < 1000) {
      console.log(`[WARN] Failed to parse SSE line (${data.length} chars): ${data.substring(0, 100)}...`);
    }
    if (options.failOnMalformedData) {
      throw new MalformedSSEDataError(data);
    }
    return null;
  }
}

// Check if chunk has valuable content (not empty)
export function hasValuableContent(chunk, format) {
  // OpenAI format
  if (format === FORMATS.OPENAI && chunk.choices?.[0]?.delta) {
    const delta = chunk.choices[0].delta;
    return delta.content && delta.content !== "" ||
           delta.reasoning_content && delta.reasoning_content !== "" ||
           delta.tool_calls && delta.tool_calls.length > 0 ||
           chunk.choices[0].finish_reason ||
           delta.role;
  }

  // Claude format
  if (format === FORMATS.CLAUDE) {
    const isContentBlockDelta = chunk.type === "content_block_delta";
    const hasText = chunk.delta?.text && chunk.delta.text !== "";
    const hasThinking = chunk.delta?.thinking && chunk.delta.thinking !== "";
    const hasInputJson = chunk.delta?.partial_json && chunk.delta.partial_json !== "";
    
    if (isContentBlockDelta && !hasText && !hasThinking && !hasInputJson) {
      return false;
    }
    return true;
  }

  return true; // Other formats: keep all chunks
}

// Fix invalid id (generic or too short)
export function fixInvalidId(parsed) {
  if (parsed.id && (parsed.id === "chat" || parsed.id === "completion" || parsed.id.length < 8)) {
    const fallbackId = parsed.extend_fields?.requestId || 
                      parsed.extend_fields?.traceId || 
                      Date.now().toString(36);
    parsed.id = `chatcmpl-${fallbackId}`;
    return true;
  }
  return false;
}

function cleanUsagePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }

  const cleaned = { ...payload };
  delete cleaned.cache_creation_input_tokens;
  delete cleaned.cache_read_input_tokens;
  return cleaned;
}

export function formatSSE(data, format = null) {
  if (data === null || data === undefined) return "";
  if (typeof data === "string") return data;
  if (format === FORMATS.OPENAI_RESPONSES && typeof data.event === "string" && "data" in data) {
    return `event: ${data.event}\ndata: ${JSON.stringify(data.data)}\n\n`;
  }
  // Anthropic Messages streaming requires a named `event:` line per frame
  // (message_start, content_block_delta, message_stop, ...). Strict Claude
  // clients switch on it. OpenAI/Gemini SSE use bare `data:` lines — never
  // add an event line there or those parsers break.
  if (format === FORMATS.CLAUDE && typeof data.type === "string") {
    return `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
  }
  return `data: ${JSON.stringify(data)}\n\n`;
}

export function formatSSEDone() {
  return "data: [DONE]\n\n";
}

export function extractUsageFromChunk(chunk, format) {
  if (!chunk) return null;

  if (format === FORMATS.CLAUDE && chunk.type === "message_delta" && chunk.usage) {
    return cleanUsagePayload(chunk.usage);
  }

  if (format === FORMATS.OPENAI && chunk.usage) {
    return cleanUsagePayload(chunk.usage);
  }

  return null;
}
