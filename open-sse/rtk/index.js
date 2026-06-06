// RTK port: compress tool_result content in LLM request bodies
// Injected at the top of translateRequest (before any format translation)
import { RAW_CAP, MIN_COMPRESS_SIZE } from "./constants.js";
import { autoDetectFilter } from "./autodetect.js";
import { safeApply } from "./applyFilter.js";
import { smartTruncate } from "./filters/smartTruncate.js";

let rtkEnabled = false;

export function setRtkEnabled(enabled) {
  rtkEnabled = enabled === true;
}

export function isRtkEnabled() {
  return rtkEnabled;
}

// Returns the index of the last message that carries a cache_control marker
// (either at the top-level or inside a content block). RTK must not touch
// any message at or before this index — doing so would change the content
// hash and invalidate the Anthropic/OpenAI KV cache.
export function findLastCacheBoundary(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;
    if (msg.cache_control) return i;
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block?.cache_control) return i;
      }
    }
  }
  return -1;
}

function snapshotCacheProtectedRegion(items, cacheFloor) {
  if (cacheFloor < 0 || !Array.isArray(items)) return null;
  const snap = [];
  for (let i = 0; i <= cacheFloor; i++) {
    snap.push(JSON.stringify(items[i]));
  }
  return snap;
}

function verifyCacheBoundaryIntegrity(items, cacheFloor, snapshot) {
  if (cacheFloor < 0 || !snapshot) return true;
  for (let i = 0; i <= cacheFloor; i++) {
    if (JSON.stringify(items[i]) !== snapshot[i]) return false;
  }
  return true;
}

function restoreItems(items, snapshot) {
  if (!Array.isArray(items) || !Array.isArray(snapshot)) return;
  for (let i = 0; i < snapshot.length; i++) {
    items[i] = snapshot[i];
  }
}

// Compress tool_result content in-place. Returns stats or null if disabled/failed.
export function compressMessages(body, enabled = rtkEnabled) {
  if (!enabled) return null;
  if (!body) return null;

  // Kiro format: conversationState.history + conversationState.currentMessage
  if (body.conversationState) {
    return compressKiroFormat(body, enabled);
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
    itemsSnapshot = items.map((item) => JSON.parse(JSON.stringify(item)));
    for (let i = 0; i < items.length; i++) {
      if (i <= cacheFloor) continue; // protected by cache boundary
      const msg = items[i];
      if (!msg) continue;

      // Shape 4: OpenAI Responses — top-level { type:"function_call_output", output: string | [{type:"input_text", text}] }
      if (msg.type === "function_call_output") {
        if (typeof msg.output === "string") {
          msg.output = compressText(msg.output, stats, "openai-responses-string");
        } else if (Array.isArray(msg.output)) {
          for (let k = 0; k < msg.output.length; k++) {
            const part = msg.output[k];
            if (part && part.type === "input_text" && typeof part.text === "string") {
              part.text = compressText(part.text, stats, "openai-responses-array");
            }
          }
        }
        continue;
      }

      // Shape 1: OpenAI tool message — { role:"tool", content: "string" }
      if (msg.role === "tool" && typeof msg.content === "string") {
        msg.content = compressText(msg.content, stats, "openai-tool");
        continue;
      }

      if (!Array.isArray(msg.content)) continue;

      // Shape 1b: OpenAI tool message — { role:"tool", content:[{type:"text", text:"..."}] }
      if (msg.role === "tool") {
        for (let k = 0; k < msg.content.length; k++) {
          const part = msg.content[k];
          if (part && part.type === "text" && typeof part.text === "string") {
            part.text = compressText(part.text, stats, "openai-tool-array");
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
          block.content = compressText(block.content, stats, "claude-string");
        } else if (Array.isArray(block.content)) {
          // Shape 3: claude array form — compress each text part
          for (let k = 0; k < block.content.length; k++) {
            const part = block.content[k];
            if (part && part.type === "text" && typeof part.text === "string") {
              part.text = compressText(part.text, stats, "claude-array");
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

// Compress Kiro format: conversationState.history[].userInputMessage.userInputMessageContext.toolResults[].content[].text
function compressKiroFormat(body, enabled) {
  const stats = { bytesBefore: 0, bytesAfter: 0, hits: [] };
  try {
    const state = body.conversationState;
    const allMessages = [...(Array.isArray(state?.history) ? state.history : [])];
    if (state?.currentMessage) allMessages.push(state.currentMessage);

    for (const msg of allMessages) {
      const toolResults = msg?.userInputMessage?.userInputMessageContext?.toolResults;
      if (!Array.isArray(toolResults)) continue;

      for (const tr of toolResults) {
        if (tr.status === "error") continue; // preserve error traces
        if (!Array.isArray(tr.content)) continue;

        for (const part of tr.content) {
          if (part && typeof part.text === "string") {
            part.text = compressText(part.text, stats, "kiro-tool-result");
          }
        }
      }
    }
  } catch (e) {
    console.warn("[RTK] compressKiroFormat error:", e.message);
    return null;
  }
  return stats;
}

function compressText(text, stats, shape) {
  const bytesIn = text.length;
  stats.bytesBefore += bytesIn;

  if (bytesIn < MIN_COMPRESS_SIZE || bytesIn > RAW_CAP) {
    stats.bytesAfter += bytesIn;
    return text;
  }

  const namedFilter = autoDetectFilter(text);
  const candidates = [];

  if (namedFilter && namedFilter.filterName !== "smart-truncate") {
    const namedOut = safeApply(namedFilter, text);
    if (namedOut && namedOut.length > 0 && namedOut.length < bytesIn) {
      candidates.push({ out: namedOut, filter: namedFilter.filterName || namedFilter.name || "named" });
    }
  }

  // Fallback (Req 7.8) and secondary fallback when named filter fails or grows (Req 7.9, 7.10)
  const truncOut = safeApply(smartTruncate, text);
  if (truncOut && truncOut.length > 0 && truncOut.length < bytesIn) {
    candidates.push({ out: truncOut, filter: "smart-truncate" });
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
