/**
 * Stream-to-JSON Converter
 * Converts Responses API SSE stream to single JSON response
 * Used when client requests non-streaming but provider forces streaming (e.g., Codex)
 */

/**
 * Infer Responses API event type when upstream omits the event: line.
 */
function inferEventType(parsed) {
  if (parsed && typeof parsed.type === "string" && parsed.type.startsWith("response.")) {
    return parsed.type;
  }
  return "message";
}

/**
 * Process a single SSE message and update state accordingly.
 */
function processSSEMessage(msg, state) {
  if (!msg.trim()) return;

  const eventMatch = msg.match(/^event:\s*(.+)$/m);
  const dataMatch = msg.match(/^data:\s*(.+)$/m);
  if (!dataMatch) return;

  const dataStr = dataMatch[1].trim();
  if (dataStr === "[DONE]") return;

  let parsed;
  try { parsed = JSON.parse(dataStr); }
  catch {
    state.status = "failed";
    state.parseError = true;
    return;
  }

  const eventType = eventMatch ? eventMatch[1].trim() : inferEventType(parsed);

  if (eventType === "response.created") {
    state.responseId = parsed.response?.id || state.responseId;
    state.created = parsed.response?.created_at || state.created;
  } else if (eventType === "response.output_item.done") {
    if (!parsed.item) {
      state.status = "failed";
      return;
    }
    // Some translators reuse output_index across distinct items (e.g. a tool_call
    // emitted at index 0 alongside a message/reasoning item also at index 0).
    // A plain set() would overwrite the earlier item and lose it. If the slot is
    // already taken by a different item id, append at the next free numeric slot
    // so every item survives (consumer below builds the output array by index).
    const idx = parsed.output_index ?? 0;
    const existing = state.items.get(idx);
    if (existing && existing.id !== parsed.item?.id) {
      let free = state.items.size;
      while (state.items.has(free)) free++;
      state.items.set(free, parsed.item);
    } else {
      state.items.set(idx, parsed.item);
    }
  } else if (eventType === "response.completed") {
    // Sticky-fail: a prior parse error or explicit failure must not be overwritten.
    if (!state.parseError && state.status !== "failed") {
      state.status = "completed";
    }
    if (parsed.response?.usage) {
      state.usage.input_tokens = parsed.response.usage.input_tokens || 0;
      state.usage.output_tokens = parsed.response.usage.output_tokens || 0;
      state.usage.total_tokens = parsed.response.usage.total_tokens || 0;
    }
  } else if (eventType === "response.failed") {
    state.status = "failed";
  }
}

const EMPTY_RESPONSE = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

/**
 * Convert Responses API SSE stream to single JSON response
 * @param {ReadableStream} stream - SSE stream from provider
 * @returns {Promise<Object>} Final JSON response in Responses API format
 */
export async function convertResponsesStreamToJson(stream) {
  if (!stream || typeof stream.getReader !== "function") {
    return { id: `resp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, object: "response", created_at: Math.floor(Date.now() / 1000), status: "failed", output: [], usage: { ...EMPTY_RESPONSE } };
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const state = {
    responseId: "",
    created: Math.floor(Date.now() / 1000),
    status: "in_progress",
    usage: { ...EMPTY_RESPONSE },
    items: new Map()
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const messages = buffer.split("\n\n");
      buffer = messages.pop() || "";

      for (const msg of messages) {
        processSSEMessage(msg, state);
      }
    }

    // Flush remaining buffer (last event may not end with \n\n)
    if (buffer.trim()) {
      processSSEMessage(buffer, state);
    }
  } finally {
    reader.releaseLock();
  }

  // Build output array from accumulated items (ordered by index).
  // Fail closed on index gaps — never fabricate placeholder items.
  const output = [];
  if (state.items.size > 0) {
    const maxIndex = Math.max(...state.items.keys());
    let hasGap = false;
    for (let i = 0; i <= maxIndex; i++) {
      const item = state.items.get(i);
      if (!item) {
        hasGap = true;
        break;
      }
      output.push(item);
    }
    if (hasGap) {
      state.status = "failed";
    }
  }

  if (state.parseError) {
    state.status = "failed";
  }

  return {
    id: state.responseId || `resp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    object: "response",
    created_at: state.created,
    // Keep the real terminal status. Do NOT coerce a missing terminal event
    // (still "in_progress") into "completed" — that would mask a truncated stream.
    status: state.status,
    output,
    usage: state.usage
  };
}
