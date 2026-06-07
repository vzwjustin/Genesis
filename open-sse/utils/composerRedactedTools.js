/**
 * Composer/Cursor/Kimi redacted tool-call text tokens (see src/mitm/handlers/composerRedactedTools.js).
 */

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

export function parseRedactedToolArgs(argsStr) {
  const parsed = parseToolCallBody(`x <|tool_sep|>${argsStr}`);
  return parsed ? parsed.arguments : "{}";
}
