/**
 * Composer/Cursor/Kimi redacted tool-call text tokens (see src/mitm/handlers/composerRedactedTools.js).
 */

export function normalizeRedactedMarkers(text) {
  return String(text || "").replace(/\uFF5C/g, "|").replace(/\u2581/g, "_");
}

const BLOCK_RES = [
  /<\|redacted_tool_calls_begin\|>([\s\S]*?)<\|redacted_tool_calls_end\|>/g,
  /<\|tool_calls_begin\|>([\s\S]*?)<\|tool_calls_end\|>/g,
];

const CALL_RES = [
  /<\|redacted_tool_call_begin\|>\s*([\s\S]*?)<\|redacted_tool_call_end\|>/g,
  /<\|redacted_tool_call_begin_kimi\|>\s*([\s\S]*?)<\|redacted_tool_call_end_kimi\|>/g,
  /<\|tool_call_begin\|>\s*([\s\S]*?)<\|tool_call_end\|>/g,
];

const TOOL_SEP_RE = /<\|(?:redacted_)?tool_sep\|>/g;
const PARTIAL_MARKER_RE = /<\|(?:redacted_tool(?:_calls?|_sep)?|tool_calls(?:_begin|_end)?|tool_sep)[\s\S]*$/i;
const FINAL_MARKER = "<|final|>";
/** Composer tool-trace lines in visible thinking (before <|final|>). */
const TOOL_ACTIVITY_LINE_RE = /^(?:✱\s*\w+|→\s*\w+)/;

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
    arguments: JSON.stringify(args),
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

export function extractRedactedToolCalls(text) {
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

export function stripRedactedToolCalls(text) {
  const normalized = normalizeRedactedMarkers(text);
  return removeToolBlocks(normalized).replace(PARTIAL_MARKER_RE, "").trimEnd();
}

/** Strip Composer's visible-answer prefix (ASCII or fullwidth pipes). */
export function stripComposerFinalPrefix(text) {
  const normalized = normalizeRedactedMarkers(String(text || ""));
  return normalized
    .replace(/^<\|final\|>\s*/i, "")
    .replace(/^<\|final/i, "")
    .trimStart();
}

/** Remove Composer tool-activity trace lines (✱Glob, →Read, etc.) from visible thinking. */
export function stripComposerToolActivity(text) {
  return String(text || "")
    .split(/\r?\n/)
    .filter((line) => !TOOL_ACTIVITY_LINE_RE.test(line.trim()))
    .join("\n");
}

/**
 * Incremental line buffer for stripComposerToolActivity — tool-trace lines may
 * arrive split across streaming chunks (e.g. "→Re" + "ad file\\n").
 */
export class ComposerToolActivityLineProcessor {
  constructor() {
    this.pendingLine = "";
  }

  processChunk(chunk) {
    const combined = this.pendingLine + String(chunk || "");
    const lines = combined.split(/\r?\n/);
    this.pendingLine = lines.pop() ?? "";
    return lines
      .filter((line) => !TOOL_ACTIVITY_LINE_RE.test(line.trim()))
      .join("\n");
  }

  flush() {
    const line = this.pendingLine;
    this.pendingLine = "";
    if (!line) return "";
    return TOOL_ACTIVITY_LINE_RE.test(line.trim()) ? "" : line;
  }
}

/**
 * Raw post-</think> visible text after <|final|> (markers preserved for parsing).
 */
export function extractComposerThinkingRawVisible(thinking, { allowPreFinalFallback = false } = {}) {
  const normalized = normalizeRedactedMarkers(String(thinking || ""));
  const endTag = "</think>";
  const endIdx = normalized.lastIndexOf(endTag);
  if (endIdx < 0) return "";

  let visible = normalized.slice(endIdx + endTag.length);
  const lower = visible.toLowerCase();
  const lastFinalIdx = lower.lastIndexOf(FINAL_MARKER);
  if (lastFinalIdx >= 0) {
    visible = visible.slice(lastFinalIdx + FINAL_MARKER.length);
  } else {
    const partialIdx = lower.indexOf("<|final");
    if (partialIdx >= 0 && allowPreFinalFallback) {
      visible = visible.slice(partialIdx + "<|final".length);
    } else if (!allowPreFinalFallback) {
      return "";
    }
  }
  return visible;
}

/**
 * Extract user-facing answer from Composer thinking. Tool traces appear after
 * </think> but before <|final|>; only post-final text is emitted
 * unless allowPreFinalFallback is set (end-of-stream).
 */
export function extractComposerThinkingAnswer(thinking, options) {
  return sanitizeComposerVisibleText(extractComposerThinkingRawVisible(thinking, options));
}

export function sanitizeComposerVisibleText(text) {
  const stripped = stripRedactedToolCalls(String(text || ""));
  const noTraces = stripComposerToolActivity(stripped);
  return stripComposerFinalPrefix(noTraces);
}

/** Stateful sanitizer for streaming chunks (line-buffered tool-activity stripping). */
export function createStreamingComposerSanitizer() {
  const activityLines = new ComposerToolActivityLineProcessor();
  return {
    sanitizeChunk(text) {
      const stripped = stripRedactedToolCalls(String(text || ""));
      const noTraces = activityLines.processChunk(stripped);
      return stripComposerFinalPrefix(noTraces);
    },
    flush() {
      const pending = activityLines.flush();
      if (!pending) return "";
      return stripComposerFinalPrefix(stripRedactedToolCalls(pending));
    },
  };
}

/**
 * Incremental processor for streaming assistant text that may contain redacted
 * tool-call markers split across chunks.
 */
export class RedactedToolContentProcessor {
  constructor() {
    this.buffer = "";
  }

  processChunk(chunk) {
    this.buffer += chunk;
    const normalized = normalizeRedactedMarkers(this.buffer);
    const toolCalls = extractRedactedToolCalls(normalized);

    const splitIdx = this._pendingStart(normalized);
    const consumed = splitIdx >= 0 ? normalized.slice(0, splitIdx) : normalized;
    this.buffer = splitIdx >= 0 ? normalized.slice(splitIdx) : "";

    const emitText = removeToolBlocks(consumed);

    return { text: emitText, toolCalls };
  }

  _pendingStart(s) {
    const OPEN_RE = /<\|(?:redacted_)?tool_calls_begin\|>/gi;
    const opens = [];
    let m;
    while ((m = OPEN_RE.exec(s)) !== null) opens.push(m.index);
    const closeCount = (s.match(/<\|(?:redacted_)?tool_calls_end\|>/gi) || []).length;
    if (opens.length > closeCount) return opens[closeCount];

    const idx = s.lastIndexOf("<|");
    if (idx >= 0) {
      const suf = s.slice(idx);
      const incomplete =
        /^<\|[a-z_]*$/i.test(suf) ||
        (/^<\|(?:redacted|tool)/i.test(suf) && !suf.slice(2).includes("|>")) ||
        (/^<\|final/i.test(suf) && !suf.includes("|>"));
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
