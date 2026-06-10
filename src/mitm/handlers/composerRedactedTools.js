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
  // Plain (non-redacted) variant — DeepSeek/Kimi/Composer emit this inside a
  // <|tool_calls_begin|> block (see header examples). The "redacted_" prefixed
  // patterns above don't match it, so without this the call is silently dropped.
  /<\|tool_call_begin\|>\s*([\s\S]*?)<\|tool_call_end\|>/g,
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
    // Normalize once. normalizeRedactedMarkers is length-preserving (\uFF5C\u2192|, \u2581\u2192_),
    // so indices into `normalized` are valid offsets into the stored buffer too.
    const normalized = normalizeRedactedMarkers(this.buffer);
    const toolCalls = extractRedactedToolCalls(normalized);

    // Hold back any unfinished trailing region for the next chunk. Must split at
    // the OUTER block opener (`<|tool_calls_begin|>`) of an unclosed block \u2014 not at
    // an inner `<|tool_call_begin|>` \u2014 otherwise the orphaned outer opener leaks
    // into text and the block never re-parses once completed.
    const splitIdx = this._pendingStart(normalized);
    const consumed = splitIdx >= 0 ? normalized.slice(0, splitIdx) : normalized;
    this.buffer = splitIdx >= 0 ? normalized.slice(splitIdx) : "";

    // Strip complete tool blocks from the emitted text.
    const emitText = removeToolBlocks(consumed);

    return { text: emitText, toolCalls };
  }

  /**
   * Index where the unconsumed tail begins, or -1 if the buffer is fully consumable.
   * The tail is either an unclosed outer tool-calls block or a trailing partial marker.
   */
  _pendingStart(s) {
    // Count outer begin/end markers. If more begins than ends, the first unmatched
    // begin (the closeCount-th, 0-based) starts an unclosed block \u2192 hold from there.
    const OPEN_RE = /<\|(?:redacted_)?tool_calls_begin\|>/gi;
    const opens = [];
    let m;
    while ((m = OPEN_RE.exec(s)) !== null) opens.push(m.index);
    const closeCount = (s.match(/<\|(?:redacted_)?tool_calls_end\|>/gi) || []).length;
    if (opens.length > closeCount) return opens[closeCount];

    // All blocks closed \u2014 hold only a trailing bare/partial marker (an opener that
    // hasn't reached its `|>` yet), not a completed marker mid-buffer.
    const idx = s.lastIndexOf("<|");
    if (idx >= 0) {
      const suf = s.slice(idx);
      const incomplete =
        /^<\|[a-z_]*$/i.test(suf) ||
        (/^<\|(?:redacted|tool)/i.test(suf) && !suf.slice(2).includes("|>"));
      if (incomplete) return idx;
    }
    return -1;
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
