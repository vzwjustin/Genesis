const { err } = require("../logger");
const { IS_DEV } = require("../config");
const { fetchRouter } = require("./base");
const { RedactedToolContentProcessor } = require("./composerRedactedTools");
const fs = require("fs");
const path = require("path");

// Debug trace log — written to data/logs/mitm/kiro-debug.log (dev only)
const DEBUG_LOG = path.join(__dirname, "../../../data/logs/mitm/kiro-debug.log");
function dbg(msg) {
  if (!IS_DEV) return;
  try {
    fs.appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}

// ─── CRC32 (standard, polynomial 0xEDB88320 — same as AWS EventStream) ───────
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ─── AWS EventStream frame builder ────────────────────────────────────────────
/**
 * Encode a single string header into the AWS EventStream binary format.
 * Header wire format: [nameLen 1B][name][type=7 1B][valueLen 2B][value]
 */
function encodeHeader(name, value) {
  const nameBuf = Buffer.from(name, "utf8");
  const valueBuf = Buffer.from(value, "utf8");
  const buf = Buffer.alloc(1 + nameBuf.length + 1 + 2 + valueBuf.length);
  let o = 0;
  buf[o++] = nameBuf.length;
  nameBuf.copy(buf, o); o += nameBuf.length;
  buf[o++] = 7; // string type
  buf.writeUInt16BE(valueBuf.length, o); o += 2;
  valueBuf.copy(buf, o);
  return buf;
}

/**
 * Build a single AWS EventStream binary frame with all Smithy-required headers.
 *
 * Frame layout (big-endian):
 *   [totalLen 4B][headersLen 4B][preludeCRC 4B]
 *   [headers ...][payload JSON ...][messageCRC 4B]
 *
 * The SmithyMessageDecoderStream layer requires three system headers on every frame:
 *   :message-type  = "event"             (or "exception" / "error")
 *   :event-type    = e.g. "assistantResponseEvent"
 *   :content-type  = "application/json"
 */
function buildEventStreamFrame(eventType, payload, opts = {}) {
  const payloadBuf = Buffer.from(
    typeof payload === "string" ? payload : JSON.stringify(payload),
    "utf8"
  );

  // Exceptions use :message-type "exception" + :exception-type (not :event-type),
  // so Kiro's Smithy decoder routes them to error handling instead of treating
  // the frame as a normal event.
  const isException = opts.messageType === "exception";
  const headersBuf = Buffer.concat([
    encodeHeader(":message-type", isException ? "exception" : "event"),
    encodeHeader(isException ? ":exception-type" : ":event-type", eventType),
    encodeHeader(":content-type", "application/json"),
  ]);
  const headersLen = headersBuf.length;

  const totalLen = 4 + 4 + 4 + headersLen + payloadBuf.length + 4;
  const frame = Buffer.alloc(totalLen);

  frame.writeUInt32BE(totalLen, 0);
  frame.writeUInt32BE(headersLen, 4);
  frame.writeUInt32BE(crc32(frame.slice(0, 8)), 8); // prelude CRC
  headersBuf.copy(frame, 12);
  payloadBuf.copy(frame, 12 + headersLen);
  frame.writeUInt32BE(crc32(frame.slice(0, totalLen - 4)), totalLen - 4); // message CRC

  return frame;
}

// ─── CodeWhisperer → OpenAI conversion ───────────────────────────────────────

/**
 * Safely stringify a tool-call input value.
 * OpenAI expects `function.arguments` to be a JSON string, never an object.
 * If 9router's Anthropic→OpenAI conversion passes the input as a pre-parsed object,
 * this prevents the "" + object → "[object Object]" corruption.
 */
function safeArgsString(value) {
  if (typeof value === "string") return value;
  if (value == null) return "{}";
  try { return JSON.stringify(value); } catch { return "{}"; }
}

/**
 * Convert a CodeWhisperer userInputMessage to one or more OpenAI messages.
 *
 * A user turn can contain:
 *   - plain text content  → { role:"user", content }
 *   - toolResults only    → one { role:"tool", tool_call_id, content } per result
 *   - both                → tool messages first, then the user text message
 */
function convertUserInputMessage(uim) {
  const out = [];
  const toolResults = uim.userInputMessageContext?.toolResults || [];

  // Emit one "tool" message per tool result (OpenAI multi-tool format).
  // Content blocks may be { text } OR { json } (structured tool output) —
  // dropping json blocks would send the model an empty tool result.
  for (const tr of toolResults) {
    const text = (tr.content || [])
      .map(c => {
        if (typeof c?.text === "string") return c.text;
        if (c?.json !== undefined) {
          try { return JSON.stringify(c.json); } catch { return ""; }
        }
        return "";
      })
      .join("\n");
    out.push({
      role: "tool",
      tool_call_id: tr.toolUseId || "",
      content: text,
    });
  }

  // Emit user text only if it exists alongside OR when there are no tool results
  const text = (uim.content || "").trim();
  if (text || toolResults.length === 0) {
    out.push({ role: "user", content: text });
  }

  return out;
}

/**
 * Convert a CodeWhisperer assistantResponseMessage to an OpenAI assistant message.
 *
 * The assistant turn can contain:
 *   - plain text content
 *   - toolUses (tool calls)  → tool_calls[] on the assistant message
 */
function convertAssistantResponseMessage(arm) {
  const toolUses = arm.toolUses || [];

  if (toolUses.length > 0) {
    return {
      role: "assistant",
      content: arm.content || null,
      tool_calls: toolUses.map((tu, i) => ({
        // index suffix avoids duplicate ids when several toolUses lack toolUseId
        id: tu.toolUseId || `call_${Date.now()}_${i}`,
        type: "function",
        function: {
          name: tu.name || "",
          arguments: safeArgsString(tu.input),
        },
      })),
    };
  }

  return { role: "assistant", content: arm.content || "" };
}

/**
 * Convert AWS CodeWhisperer conversationState to an OpenAI messages array.
 *
 * Full multi-turn shape:
 *   history: [
 *     { userInputMessage: { content, userInputMessageContext?: { toolResults?, tools? } } },
 *     { assistantResponseMessage: { content, toolUses?: [...] } },
 *     ...
 *   ]
 *   currentMessage: { userInputMessage: { content, userInputMessageContext?: { toolResults? } } }
 */
function codeWhispererToMessages(body) {
  const cs = body.conversationState || {};
  const history = cs.history || [];
  const currentMsg = cs.currentMessage;
  const messages = [];

  for (const item of history) {
    if (item.userInputMessage) {
      messages.push(...convertUserInputMessage(item.userInputMessage));
    } else if (item.assistantResponseMessage) {
      messages.push(convertAssistantResponseMessage(item.assistantResponseMessage));
    }
  }

  // Append the current (latest) turn
  if (currentMsg?.userInputMessage) {
    messages.push(...convertUserInputMessage(currentMsg.userInputMessage));
  }

  return messages;
}

/**
 * Extract tool definitions from a CodeWhisperer request and convert to OpenAI format.
 *
 * CodeWhisperer tools live in:
 *   conversationState.currentMessage.userInputMessage.userInputMessageContext.tools
 * OR (in multi-turn) the first history item's userInputMessageContext.tools
 *
 * CodeWhisperer tool shape:
 *   { toolSpecification: { name, description, inputSchema: { json: <schema> } } }
 *
 * OpenAI tool shape:
 *   { type: "function", function: { name, description, parameters: <schema> } }
 */
function extractTools(body) {
  const cs = body.conversationState || {};

  // Tools are typically on the currentMessage; may also appear on the first history item
  const fromCurrent = cs.currentMessage?.userInputMessage?.userInputMessageContext?.tools || [];
  const fromHistory = cs.history?.find(h => h.userInputMessage?.userInputMessageContext?.tools)
    ?.userInputMessage?.userInputMessageContext?.tools || [];
  const cwTools = fromCurrent.length > 0 ? fromCurrent : fromHistory;

  if (!cwTools.length) return [];

  return cwTools.map(item => {
    const spec = item.toolSpecification || item;
    return {
      type: "function",
      function: {
        name: spec.name || "",
        description: spec.description || `Tool: ${spec.name || "unknown"}`,
        parameters: spec.inputSchema?.json || { type: "object", properties: {}, required: [] },
      },
    };
  });
}

// ─── OpenAI SSE → EventStream binary conversion ───────────────────────────────
/**
 * Read 9router's OpenAI SSE response and re-encode it as AWS EventStream binary
 * frames that Kiro's Smithy SDK expects.
 *
 * OpenAI SSE format:  data: { choices:[{ delta:{ content:"..." } }] }\n\n
 * EventStream events emitted:
 *   assistantResponseEvent  { content: "..." }   — one per SSE chunk with text
 *   toolUseEvent            { toolUseId, name, input }   — for tool calls
 *   messageStopEvent        {}                   — on finish
 */
async function pipeOpenAIasEventStream(routerRes, res) {
  if (!routerRes.body) {
    res.end(buildEventStreamFrame("messageStopEvent", {}));
    return;
  }

  const reader = routerRes.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = "";
  let stopSent = false;

  // Accumulated tool-call state keyed by index
  const toolCallAccum = {};
  const contentProcessor = new RedactedToolContentProcessor();

  const emitToolUseEvents = (toolCalls) => {
    for (const tc of toolCalls) {
      // input must be a serialized JSON STRING; stop:true tells Kiro's Smithy
      // decoder this ToolUse is complete so it parses input → object. Without
      // stop, toolUse.input stays undefined → agentic controller crashes on
      // `toolUse.input.explanation`.
      res.write(buildEventStreamFrame("toolUseEvent", {
        toolUseId: contentProcessor.nextToolUseId(),
        name: tc.name,
        input: safeArgsString(tc.input),
        stop: true,
      }));
    }
  };

  const sendStop = () => {
    if (!stopSent) {
      stopSent = true;
      res.write(buildEventStreamFrame("messageStopEvent", {}));
    }
  };

  // Flush natively-streamed (OpenAI tool_calls delta) accumulated tool calls.
  // Must run regardless of finish_reason value AND on stream end — some providers
  // send finish_reason "stop" (not "tool_calls") or omit it entirely, which would
  // otherwise drop the tool calls. Guarded so finish + finally don't double-emit.
  let nativeFlushed = false;
  const flushNativeToolCalls = () => {
    if (nativeFlushed) return;
    const accs = Object.values(toolCallAccum);
    if (accs.length === 0) return;
    nativeFlushed = true;
    for (const acc of accs) {
      const inputStr = acc.args || "{}";
      dbg(`  toolUseEvent: id=${acc.id} name=${acc.name} inputStr=${inputStr.slice(0, 200)}`);
      res.write(buildEventStreamFrame("toolUseEvent", {
        // Fall back to a synthetic id when the provider streams tool_calls
        // without an id — empty toolUseId breaks toolResult correlation.
        toolUseId: acc.id || contentProcessor.nextToolUseId(),
        name: acc.name,
        input: inputStr,  // Must be a JSON STRING, not a parsed object
        stop: true,       // Marks input complete → Kiro parses it; without this
                          // toolUse.input stays undefined → ".explanation" crash
      }));
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      sseBuffer += decoder.decode(value, { stream: true });

      // Split on newlines; keep the last (possibly incomplete) line in the buffer
      const lines = sseBuffer.split("\n");
      sseBuffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;

        const raw = trimmed.slice(5).trim();
        if (raw === "[DONE]") {
          sendStop();
          continue;
        }

        let chunk;
        try { chunk = JSON.parse(raw); } catch { continue; }

        const delta = chunk?.choices?.[0]?.delta;
        if (!delta) continue;

        // ── Text content (strip Composer redacted tool-call tokens) ─────────────
        if (delta.content) {
          const { text, toolCalls } = contentProcessor.processChunk(delta.content);
          if (text) {
            res.write(buildEventStreamFrame("assistantResponseEvent", { content: text }));
          }
          emitToolUseEvents(toolCalls);
        }

        // ── Tool calls (streamed in pieces by OpenAI SSE) ──────────────────────
        if (delta.tool_calls) {
          dbg(`TOOL_CALLS delta: ${JSON.stringify(delta.tool_calls).slice(0, 300)}`);
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCallAccum[idx]) {
              toolCallAccum[idx] = { id: tc.id ?? "", name: "", args: "" };
            }
            const acc = toolCallAccum[idx];
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name += tc.function.name;
            // safeArgsString prevents `"" + object` → "[object Object]" corruption
            // when 9router's Anthropic→OpenAI conversion passes a pre-parsed object
            const argType = typeof tc.function?.arguments;
            if (tc.function?.arguments != null) {
              acc.args += safeArgsString(tc.function.arguments);
            }
            dbg(`  tc[${idx}] argType=${argType} id=${acc.id} name=${acc.name} args_so_far=${acc.args.slice(0, 100)}`);
          }
        }

        // ── Finish ─────────────────────────────────────────────────────────────
        const finish = chunk?.choices?.[0]?.finish_reason;
        if (finish) {
          dbg(`FINISH finish_reason=${finish} toolCallKeys=${JSON.stringify(Object.keys(toolCallAccum))}`);
          // Flush accumulated tool calls before stop. Kiro's tool dispatcher expects
          // `input` as a JSON STRING (it JSON.parses it); a parsed object would become
          // String(obj) → "[object Object]". Flush on ANY finish, not just
          // finish_reason === "tool_calls" — some providers end with "stop".
          flushNativeToolCalls();
          sendStop();
        }
      }
    }
  } finally {
    // Stream may have ended without a finish chunk — flush any accumulated
    // native tool calls so they aren't dropped (no-op if already flushed).
    flushNativeToolCalls();
    const flushed = contentProcessor.flush();
    if (flushed.text) {
      res.write(buildEventStreamFrame("assistantResponseEvent", { content: flushed.text }));
    }
    emitToolUseEvents(flushed.toolCalls);
    sendStop();
    res.end();
  }
}

/**
 * True when this Kiro request is part of a tool-call round and must not be translated.
 * Tool execution turns carry toolResults and/or follow assistant toolUses; MITM
 * translation can break signing, EventStream framing, and tool-result validation.
 */
function kiroRequiresPassthrough(bodyBuffer) {
  try {
    const body = JSON.parse(bodyBuffer.toString());
    const cs = body.conversationState;
    if (!cs) return false;

    const hasToolResults = (uim) => {
      const results = uim?.userInputMessageContext?.toolResults;
      return Array.isArray(results) && results.length > 0;
    };

    if (hasToolResults(cs.currentMessage?.userInputMessage)) return true;

    for (const item of cs.history || []) {
      const toolUses = item.assistantResponseMessage?.toolUses;
      if (Array.isArray(toolUses) && toolUses.length > 0) return true;
      if (hasToolResults(item.userInputMessage)) return true;
    }

    return false;
  } catch {
    return false;
  }
}

// ─── MITM intercept entry point ───────────────────────────────────────────────
/**
 * Intercept Kiro IDE CodeWhisperer request:
 *   1. Parse CodeWhisperer binary/JSON body
 *   2. Convert to OpenAI messages[] format
 *   3. Forward to 9router /v1/chat/completions (OpenAI SSE)
 *   4. Convert OpenAI SSE response → AWS EventStream binary frames
 *   5. Stream binary frames back to Kiro
 */
async function intercept(req, res, bodyBuffer, mappedModel) {
  try {
    const body = JSON.parse(bodyBuffer.toString());

    // 1 + 2: CodeWhisperer → OpenAI messages + tools
    const messages = codeWhispererToMessages(body);
    if (messages.length === 0) {
      throw new Error("codeWhispererToMessages produced 0 messages — check request body");
    }

    const tools = extractTools(body);

    const openaiBody = {
      model: mappedModel,
      messages,
      stream: true,
      // Forward tools so Claude uses structured tool_calls instead of XML text fallback
      ...(tools.length > 0 && { tools, tool_choice: "auto" }),
    };

    // 3: Forward to 9router
    const routerRes = await fetchRouter(openaiBody, "/v1/chat/completions", req.headers);

    // Router error (non-2xx) bodies are JSON, not SSE — piping them yields an
    // empty eventstream. Surface as an exception frame instead.
    if (routerRes.status >= 400) {
      let detail = "";
      try { detail = await routerRes.text(); } catch {}
      throw new Error(`router ${routerRes.status}: ${detail.slice(0, 500)}`);
    }

    // 4 + 5: Re-encode response as AWS EventStream binary
    res.writeHead(routerRes.status, {
      "Content-Type": "application/vnd.amazon.eventstream",
      "x-amzn-requestid": `mitm-${Date.now()}`,
      "x-amz-id-2": "mitm",
      "Transfer-Encoding": "chunked",
    });

    await pipeOpenAIasEventStream(routerRes, res);
  } catch (error) {
    err(`[Kiro] ${error.message}`);
    if (!res.headersSent) {
      res.writeHead(200, {
        "Content-Type": "application/vnd.amazon.eventstream",
        "x-amzn-requestid": `mitm-${Date.now()}`,
        "x-amz-id-2": "mitm",
        "Transfer-Encoding": "chunked",
      });
    }
    try {
      res.write(buildEventStreamFrame("internalServerException", JSON.stringify({ message: error.message }), { messageType: "exception" }));
      res.write(buildEventStreamFrame("messageStopEvent", {}));
    } catch {}
    res.end();
  }
}

module.exports = { intercept, kiroRequiresPassthrough };
