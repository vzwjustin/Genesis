// RTK port: compress tool_result content in LLM request bodies
// Injected at the top of translateRequest (before any format translation)
import { RAW_CAP, MIN_COMPRESS_SIZE } from "./constants.js";
import { autoDetectFilter } from "./autodetect.js";
import { safeApply } from "./applyFilter.js";
import { smartTruncate } from "./filters/smartTruncate.js";
import {
  findLastCacheBoundary,
  shouldSkipMessageForCache,
  hasAnthropicCacheBreakpoints,
} from "./cacheBoundary.js";

export { findLastCacheBoundary } from "./cacheBoundary.js";

// Latest tool output in the request — Claude Code usually appends new tool results here.
export function findLastToolOutputMessageIndex(items) {
  if (!Array.isArray(items)) return -1;
  for (let i = items.length - 1; i >= 0; i--) {
    const msg = items[i];
    if (!msg) continue;
    if (msg.role === "tool") return i;
    if (msg.type === "function_call_output") return i;
    if (Array.isArray(msg.content) && msg.content.some((block) => block?.type === "tool_result")) {
      return i;
    }
  }
  return -1;
}

let rtkEnabled = false;

export function setRtkEnabled(enabled) {
  rtkEnabled = enabled === true;
}

export function isRtkEnabled() {
  return rtkEnabled;
}

function restoreItems(items, snapshot) {
  if (!Array.isArray(items) || !Array.isArray(snapshot)) return;
  for (let i = 0; i < snapshot.length; i++) {
    items[i] = snapshot[i];
  }
}

function snapshotCacheProtectedRegion(items, cacheFloor) {
  if (!Array.isArray(items)) return null;
  const snap = [];
  for (let i = 0; i < items.length; i++) {
    if (shouldSkipMessageForCache(i, items, cacheFloor)) {
      snap.push(JSON.stringify(items[i]));
    } else {
      snap.push(null);
    }
  }
  return snap;
}

function verifyCacheBoundaryIntegrity(items, cacheFloor, snapshot) {
  if (!snapshot) return true;
  for (let i = 0; i < items.length; i++) {
    if (snapshot[i] == null) continue;
    if (JSON.stringify(items[i]) !== snapshot[i]) return false;
  }
  return true;
}

// Compress tool_result content in-place. Returns stats or null if disabled/failed.
export function compressMessages(body, enabled = rtkEnabled, filterConfig = null) {
  if (!enabled) return null;
  if (!body) return null;

  const clientCache = hasAnthropicCacheBreakpoints(body);

  // Kiro format: conversationState.history + conversationState.currentMessage
  if (body.conversationState && !clientCache) {
    return compressKiroFormat(body, enabled, filterConfig);
  }

  // Gemini / Antigravity: tool results live in contents[].parts[].functionResponse
  const geminiContents = Array.isArray(body.contents) ? body.contents
    : Array.isArray(body.request?.contents) ? body.request.contents
    : null;
  if (geminiContents && !clientCache) {
    return compressGeminiContents(geminiContents, filterConfig);
  }

  // Support both OpenAI/Claude "messages" and OpenAI Responses "input"
  const items = Array.isArray(body.messages) ? body.messages
    : Array.isArray(body.input) ? body.input
    : null;
  if (!items) return null;

  const stats = { bytesBefore: 0, bytesAfter: 0, hits: [] };
  let cacheFloor = -1;
  let protectedSnapshot = null;
  let itemsSnapshot = null;
  try {
    // Never compress messages at or before the last cache_control boundary —
    // those bytes are part of the cached prefix; mutating them invalidates the cache.
    cacheFloor = findLastCacheBoundary(items);
    protectedSnapshot = snapshotCacheProtectedRegion(items, cacheFloor);
    itemsSnapshot = items.map((item) => {
      try {
        return structuredClone(item);
      } catch {
        return JSON.parse(JSON.stringify(item));
      }
    });
    for (let i = 0; i < items.length; i++) {
      if (shouldSkipMessageForCache(i, items, cacheFloor)) continue;
      const msg = items[i];
      if (!msg) continue;

      // Shape 4: OpenAI Responses — top-level { type:"function_call_output", output: string | [{type:"input_text", text}] }
      if (msg.type === "function_call_output") {
        if (typeof msg.output === "string") {
          msg.output = compressText(msg.output, stats, "openai-responses-string", filterConfig);
        } else if (Array.isArray(msg.output)) {
          for (let k = 0; k < msg.output.length; k++) {
            const part = msg.output[k];
            if (part && part.type === "input_text" && typeof part.text === "string") {
              part.text = compressText(part.text, stats, "openai-responses-array", filterConfig);
            }
          }
        }
        continue;
      }

      // Shape 1: OpenAI tool message — { role:"tool", content: "string" }
      if (msg.role === "tool" && typeof msg.content === "string") {
        msg.content = compressText(msg.content, stats, "openai-tool", filterConfig);
        continue;
      }

      if (!Array.isArray(msg.content)) continue;

      // Shape 1b: OpenAI tool message — { role:"tool", content:[{type:"text", text:"..."}] }
      if (msg.role === "tool") {
        for (let k = 0; k < msg.content.length; k++) {
          const part = msg.content[k];
          if (part && part.type === "text" && typeof part.text === "string") {
            part.text = compressText(part.text, stats, "openai-tool-array", filterConfig);
          }
        }
        continue;
      }

      // Shape 2/3: blocks array with tool_result entries
      for (let j = 0; j < msg.content.length; j++) {
        const block = msg.content[j];
        if (!block || block.type !== "tool_result") continue;
        if (block.is_error === true) continue; // preserve error traces

        if (typeof block.content === "string") {
          // Shape 2: claude string form
          block.content = compressText(block.content, stats, "claude-string", filterConfig);
        } else if (Array.isArray(block.content)) {
          // Shape 3: claude array form — compress each text part
          for (let k = 0; k < block.content.length; k++) {
            const part = block.content[k];
            if (part && part.type === "text" && typeof part.text === "string") {
              part.text = compressText(part.text, stats, "claude-array", filterConfig);
            }
          }
        }
      }
    }

    if (!verifyCacheBoundaryIntegrity(items, cacheFloor, protectedSnapshot)) {
      console.error("[RTK] CRITICAL: cache boundary integrity violation — reverting all compression");
      restoreItems(items, itemsSnapshot);
      return null;
    }
  } catch (e) {
    console.warn("[RTK] compressMessages error:", e.message);
    restoreItems(items, itemsSnapshot);
    return null;
  }
  return stats;
}

function functionResponseText(response) {
  if (response == null) return null;
  if (typeof response === "string") return response;
  if (typeof response.result === "string") return response.result;
  if (response.result != null) {
    return typeof response.result === "object"
      ? JSON.stringify(response.result)
      : String(response.result);
  }
  return JSON.stringify(response);
}

function writeFunctionResponseText(fr, text) {
  if (!fr || text == null) return;
  if (fr.response && typeof fr.response === "object" && "result" in fr.response) {
    if (typeof fr.response.result === "string") {
      fr.response.result = text;
      return;
    }
    if (fr.response.result != null && typeof fr.response.result === "object") {
      try {
        fr.response.result = JSON.parse(text);
      } catch {
        fr.response.result = text;
      }
      return;
    }
    // result is null or a non-string primitive — write directly without clobbering sibling fields
    fr.response.result = text;
    return;
  }
  if (typeof fr.response === "string") {
    fr.response = text;
    return;
  }
  try {
    fr.response = JSON.parse(text);
  } catch {
    fr.response = { result: text };
  }
}

function compressFunctionResponse(fr, stats, filterConfig) {
  const text = functionResponseText(fr?.response);
  if (typeof text !== "string" || !text) return;
  const compressed = compressText(text, stats, "gemini-function-response", filterConfig);
  if (compressed !== text) writeFunctionResponseText(fr, compressed);
}

function restoreGeminiContents(contents, snapshot) {
  if (!Array.isArray(contents) || !Array.isArray(snapshot)) return;
  for (let i = 0; i < snapshot.length; i++) {
    contents[i] = snapshot[i];
  }
}

function compressGeminiContents(contents, filterConfig) {
  const stats = { bytesBefore: 0, bytesAfter: 0, hits: [] };
  const snapshot = contents.map((c) => JSON.parse(JSON.stringify(c)));
  try {
    for (const content of contents) {
      if (!Array.isArray(content?.parts)) continue;
      for (const part of content.parts) {
        if (part?.functionResponse) {
          compressFunctionResponse(part.functionResponse, stats, filterConfig);
        }
      }
    }
  } catch (e) {
    console.warn("[RTK] compressGeminiContents error:", e.message);
    restoreGeminiContents(contents, snapshot);
    return null;
  }
  return stats;
}

// Compress Kiro format: only conversationState.currentMessage tool results.
// History messages are already part of the provider's cached prefix — compressing
// them changes the content hash and invalidates the upstream KV cache. Only the
// currentMessage (which has not yet been cached) is safe to compress.
function compressKiroFormat(body, enabled, filterConfig) {
  const stats = { bytesBefore: 0, bytesAfter: 0, hits: [] };
  const state = body.conversationState;
  const currentMessageSnapshot = state?.currentMessage
    ? JSON.parse(JSON.stringify(state.currentMessage))
    : null;
  try {
    // Skip history entirely — it is cache-protected upstream.
    const messagesToCompress = state?.currentMessage ? [state.currentMessage] : [];

    for (const msg of messagesToCompress) {
      const toolResults = msg?.userInputMessage?.userInputMessageContext?.toolResults;
      if (!Array.isArray(toolResults)) continue;

      for (const tr of toolResults) {
        if (tr.status === "error") continue; // preserve error traces
        if (!Array.isArray(tr.content)) continue;

        for (const part of tr.content) {
          if (part && typeof part.text === "string") {
            part.text = compressText(part.text, stats, "kiro-tool-result", filterConfig);
          }
        }
      }
    }
  } catch (e) {
    console.warn("[RTK] compressKiroFormat error:", e.message);
    if (currentMessageSnapshot && state) {
      state.currentMessage = currentMessageSnapshot;
    }
    return null;
  }
  return stats;
}

function isFilterEnabled(filterName, filterConfig) {
  if (!filterConfig || typeof filterConfig !== "object") return true;
  const val = filterConfig[filterName];
  return val !== false;
}

function compressText(text, stats, shape, filterConfig) {
  const bytesIn = text.length;
  stats.bytesBefore += bytesIn;

  if (bytesIn < MIN_COMPRESS_SIZE || bytesIn > RAW_CAP) {
    stats.bytesAfter += bytesIn;
    return text;
  }

  const namedFilter = autoDetectFilter(text);
  const candidates = [];

  if (namedFilter && namedFilter.filterName !== "smart-truncate") {
    const name = namedFilter.filterName || namedFilter.name || "named";
    if (isFilterEnabled(name, filterConfig)) {
      const namedOut = safeApply(namedFilter, text);
      if (namedOut && namedOut.length > 0 && namedOut.length < bytesIn) {
        candidates.push({ out: namedOut, filter: name });
      }
    }
  }

  // Fallback only when named filter failed or grew the input (Req 7.8–7.10)
  if (candidates.length === 0 && isFilterEnabled("smart-truncate", filterConfig)) {
    const truncOut = safeApply(smartTruncate, text);
    if (truncOut && truncOut.length > 0 && truncOut.length < bytesIn) {
      candidates.push({ out: truncOut, filter: "smart-truncate" });
    }
  }

  if (candidates.length === 0) {
    stats.bytesAfter += bytesIn;
    return text;
  }

  const best = candidates.reduce((a, b) => (a.out.length <= b.out.length ? a : b));
  stats.bytesAfter += best.out.length;
  stats.hits.push({ shape, filter: best.filter, saved: bytesIn - best.out.length });
  return best.out;
}

// Convenience: format a log line from stats
export function formatRtkLog(stats) {
  if (!stats || !stats.hits || stats.hits.length === 0) return null;
  const saved = stats.bytesBefore - stats.bytesAfter;
  const pct = stats.bytesBefore > 0 ? ((saved / stats.bytesBefore) * 100).toFixed(1) : "0";
  const filters = Array.from(new Set(stats.hits.map(h => h.filter))).join(",");
  return `[RTK] saved ${saved}B / ${stats.bytesBefore}B (${pct}%) via [${filters}] hits=${stats.hits.length}`;
}
