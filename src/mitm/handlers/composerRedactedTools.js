/**
 * Composer/Cursor/Kimi models sometimes emit tool calls as text tokens instead of
 * OpenAI tool_calls SSE deltas. Known variants:
 *
 *   <｜tool▁calls▁begin｜>...<｜tool▁calls▁end｜>
 *   <|tool_calls_begin|>...<|tool_calls_end|>
 *
 *   <｜tool▁call▁begin｜> read_file <｜tool▁sep｜>target /path <｜tool▁call▁end｜>
 *   <|tool_call_begin|> read_file <|tool_sep|>target_file /path <|tool_sep|>limit 10 <|tool_call_end|>
 */

// Composer may emit fullwidth pipe (｜) and ▁ instead of ASCII |_.
function normalizeRedactedMarkers(text) {
  return String(text || "").replace(/\uFF5C/g, "|").replace(/\u2581/g, "_");
}

const BLOCK_RES = [
  /<\|redacted_tool_calls_begin\|>([\s\S]*?)<\|redacted_tool_calls_end\|>/g,
  /<\|tool_calls_begin\|>([\s\S]*?)<\|tool_calls_end\|>/g,
];

const CALL_RES = [
  /<\|redacted_tool_call_begin\|>\s*([\s\S]*?)<\|redacted_tool_call_end\|>/g,
  /<\|redacted_tool_call_begin_kimi\|>\s*([\s\S]*?)<\|redacted_tool_call_end_kimi\|>/g,
];

const TOOL_SEP_RE = /<\|(?:redacted_)?tool_sep\|>/g;
const PARTIAL_MARKER_RE = /<\|(?:redacted_tool(?:_calls?|_sep)?|tool_calls(?:_begin|_end)?|tool_sep)[\s\S]*$/i;

function parseToolCallBody(body) {
  const trimmed = String(body || "").trim();
  if (!trimmed) return null;

  const parts = trimmed.split(TOOL_SEP_RE);
  const name = (parts[0] || "").trim();
  if (!name) return null;

  const args = {};
  for (let i = 1; i < parts.length; i++) {
    const segment = (parts[i] || "").trim();
    if (!segment) continue;
    const kv = segment.match(/^(\w+)\s+([\s\S]+)$/);
    if (kv) args[kv[1]] = kv[2].trim();
    else args[`arg${i}`] = segment;
  }

  if (Object.keys(args).length === 0 && parts.length === 2) {
    const legacy = parts[1].trim();
    const legacyKv = legacy.match(/^(\w+)\s+([\s\S]+)$/);
    if (legacyKv) args[legacyKv[1]] = legacyKv[2].trim();
    else if (legacy) args.raw = legacy;
  }

  return {
    name,
    input: JSON.stringify(args),
  };
}

function parseRedactedToolBlock(inner) {
  const toolCalls = [];
  for (const callRe of CALL_RES) {
    const re = new RegExp(callRe.source, "g");
    let match;
    while ((match = re.exec(inner)) !== null) {
      const parsed = parseToolCallBody(match[1]);
      if (parsed) toolCalls.push(parsed);
    }
  }
  return toolCalls;
}

function removeToolBlocks(text) {
  let out = text;
  for (const blockRe of BLOCK_RES) {
    out = out.replace(new RegExp(blockRe.source, "g"), "");
  }
  return out;
}

function extractRedactedToolCalls(text) {
  const normalized = normalizeRedactedMarkers(text);
  const toolCalls = [];
  for (const blockRe of BLOCK_RES) {
    const re = new RegExp(blockRe.source, "g");
    let match;
    while ((match = re.exec(normalized)) !== null) {
      toolCalls.push(...parseRedactedToolBlock(match[1]));
    }
  }
  return toolCalls;
}

function stripRedactedToolCalls(text) {
  const normalized = normalizeRedactedMarkers(text);
  return removeToolBlocks(normalized).replace(PARTIAL_MARKER_RE, "").trimEnd();
}

/**
 * Incremental processor for streaming assistant text that may contain redacted
 * tool-call markers split across SSE chunks.
 */
class RedactedToolContentProcessor {
  constructor() {
    this.buffer = "";
    this.toolCallSeq = 0;
  }

  nextToolUseId() {
    this.toolCallSeq += 1;
    return `call_mitm_${Date.now()}_${this.toolCallSeq}`;
  }

  processChunk(chunk) {
    this.buffer += chunk;
    const normalized = normalizeRedactedMarkers(this.buffer);
    const toolCalls = extractRedactedToolCalls(normalized);
    let clean = removeToolBlocks(normalized);

    const partialIdx = Math.max(clean.lastIndexOf("<|"), clean.lastIndexOf("<\uFF5C"));
    let emitText = clean;
    const suffix = partialIdx >= 0 ? clean.slice(partialIdx) : "";
    if (partialIdx >= 0 && (/^<\|(?:redacted|tool)/i.test(suffix) || PARTIAL_MARKER_RE.test(suffix))) {
      emitText = clean.slice(0, partialIdx);
      this.buffer = this.buffer.slice(partialIdx);
    } else {
      this.buffer = "";
      emitText = clean;
    }

    return { text: emitText, toolCalls };
  }

  flush() {
    const toolCalls = extractRedactedToolCalls(this.buffer);
    const text = stripRedactedToolCalls(this.buffer);
    this.buffer = "";
    return { text, toolCalls };
  }
}

/** @deprecated use parseToolCallBody */
function parseRedactedToolArgs(argsStr) {
  const parsed = parseToolCallBody(`x <|tool_sep|>${argsStr}`);
  return parsed ? parsed.input : "{}";
}

module.exports = {
  normalizeRedactedMarkers,
  parseRedactedToolArgs,
  parseToolCallBody,
  extractRedactedToolCalls,
  stripRedactedToolCalls,
  RedactedToolContentProcessor,
};
