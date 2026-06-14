const { log, err } = require("../logger");
const { fetchRouter } = require("./base");
const { getMappedModel } = require("../modelMapping");
const {
  RedactedToolContentProcessor,
  extractRedactedToolCalls,
  stripRedactedToolCalls,
} = require("./composerRedactedTools");

let protobufMod = null;
async function loadProtobuf() {
  if (!protobufMod) {
    protobufMod = await import("../../../open-sse/utils/cursorProtobuf.js");
  }
  return protobufMod;
}

function cursorRequiresPassthrough(decoded) {
  return decoded?.kind === "tool_result" || decoded?.kind === "tool_round";
}

function emitConnectRpcFrames(res, protobuf, { text, thinking, toolCalls }) {
  const { encodeTextResponseFrame, encodeThinkingResponseFrame, encodeToolCallResponseFrame, encodeEndStreamFrame } = protobuf;
  let frames = 0;

  if (text) {
    res.write(Buffer.from(encodeTextResponseFrame(text)));
    frames++;
  }
  if (thinking) {
    res.write(Buffer.from(encodeThinkingResponseFrame(thinking)));
    frames++;
  }
  for (const tc of toolCalls || []) {
    if (!tc?.name) continue;
    res.write(Buffer.from(encodeToolCallResponseFrame({
      id: tc.id || `call_${frames}`,
      name: tc.name,
      args: tc.args || "{}",
      isLast: tc.isLast !== false,
    })));
    frames++;
  }
  if (typeof encodeEndStreamFrame === "function") {
    res.write(Buffer.from(encodeEndStreamFrame()));
    frames++;
  }
  res.end();
  return frames;
}

async function pipeJsonAsConnectRPC(routerRes, res, protobuf) {
  const text = await routerRes.text().catch(() => "");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    res.end(text);
    return 0;
  }

  const choice = parsed?.choices?.[0];
  const message = choice?.message || {};
  const rawContent = typeof message.content === "string" ? message.content : "";
  const reasoning = typeof message.reasoning_content === "string" ? message.reasoning_content : "";
  // Composer/DeepSeek may embed tool calls as text tokens in content — strip and convert.
  const content = stripRedactedToolCalls(rawContent);
  const textToolCalls = extractRedactedToolCalls(rawContent).map((tc, idx) => ({
    id: `call_text_${idx}`,
    name: tc.name,
    args: tc.input || "{}",
    isLast: true,
  }));
  const nativeToolCalls = (message.tool_calls || []).map((tc, idx) => ({
    id: tc.id || `call_${idx}`,
    name: tc.function?.name || "",
    args: tc.function?.arguments || "{}",
    isLast: true,
  }));

  return emitConnectRpcFrames(res, protobuf, {
    text: content,
    thinking: reasoning,
    toolCalls: [...nativeToolCalls, ...textToolCalls],
  });
}

async function pipeOpenAIasConnectRPC(routerRes, res, protobuf) {
  const contentType = String(routerRes.headers?.get?.("content-type") || "").toLowerCase();
  if (!contentType.includes("text/event-stream")) {
    return pipeJsonAsConnectRPC(routerRes, res, protobuf);
  }

  const { encodeTextResponseFrame, encodeThinkingResponseFrame, encodeToolCallResponseFrame, encodeEndStreamFrame } = protobuf;
  const reader = routerRes.body?.getReader?.();
  if (!reader) {
    return pipeJsonAsConnectRPC(routerRes, res, protobuf);
  }

  const decoder = new TextDecoder();
  let buffer = "";
  const toolCalls = new Map();
  let framesWritten = 0;
  // Composer/DeepSeek may stream tool calls as text tokens (Unicode ｜tool▁call｜
  // markers) inside delta.content instead of native delta.tool_calls. Strip and
  // convert them so they don't leak into the rendered text.
  const contentProcessor = new RedactedToolContentProcessor();
  let toolCallSeq = 0;

  const writeText = (text) => {
    if (!text) return;
    res.write(Buffer.from(encodeTextResponseFrame(text)));
    framesWritten++;
  };

  const writeThinking = (thinking) => {
    if (!thinking) return;
    res.write(Buffer.from(encodeThinkingResponseFrame(thinking)));
    framesWritten++;
  };

  const writeToolCall = (entry, isLast) => {
    if (!entry?.name) return;
    res.write(Buffer.from(encodeToolCallResponseFrame({
      id: entry.id,
      name: entry.name,
      args: entry.args || "{}",
      isLast,
    })));
    framesWritten++;
  };

  const flushToolCalls = (isLast = true) => {
    if (toolCalls.size === 0) return;
    for (const entry of toolCalls.values()) {
      writeToolCall(entry, isLast);
    }
    toolCalls.clear();
  };

  // Emit tool calls the content processor extracted from text tokens. The
  // processor returns { name, input } where input is a JSON args string.
  const writeTextToolCalls = (extracted) => {
    for (const tc of extracted || []) {
      if (!tc?.name) continue;
      writeToolCall({ id: `call_text_${toolCallSeq++}`, name: tc.name, args: tc.input || "{}" }, true);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";

    for (const part of parts) {
      if (!part.startsWith("data: ")) continue;
      const payload = part.slice(6).trim();
      if (payload === "[DONE]") continue;

      let chunk;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }

      const delta = chunk?.choices?.[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        const { text, toolCalls: textToolCalls } = contentProcessor.processChunk(delta.content);
        writeText(text);
        writeTextToolCalls(textToolCalls);
      }
      if (delta.reasoning_content) writeThinking(delta.reasoning_content);

      for (const tc of delta.tool_calls || []) {
        const idx = tc.index ?? 0;
        if (!toolCalls.has(idx)) {
          toolCalls.set(idx, { id: tc.id || `call_${idx}`, name: "", args: "" });
        }
        const entry = toolCalls.get(idx);
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) entry.name = tc.function.name;
        if (tc.function?.arguments) entry.args += tc.function.arguments;
      }

      const finish = chunk?.choices?.[0]?.finish_reason;
      if (finish) flushToolCalls(true);
    }
  }

  // Flush any buffered partial tool-call text the processor held back.
  const tail = contentProcessor.flush();
  writeText(tail.text);
  writeTextToolCalls(tail.toolCalls);

  flushToolCalls(true);
  if (typeof encodeEndStreamFrame === "function") {
    res.write(Buffer.from(encodeEndStreamFrame()));
    framesWritten++;
  }
  res.end();
  return framesWritten;
}

/**
 * Intercept Cursor IDE ConnectRPC chat requests:
 * decode proto → OpenAI → 9router SSE → re-encode ConnectRPC frames.
 */
async function intercept(req, res, bodyBuffer, _mappedModel, passthrough) {
  try {
    const protobuf = await loadProtobuf();
    const decoded = protobuf.decodeCursorRequest(bodyBuffer);

    if (cursorRequiresPassthrough(decoded)) {
      return passthrough(req, res, bodyBuffer);
    }

    if (decoded.kind !== "chat" || !decoded.messages?.length) {
      return passthrough(req, res, bodyBuffer);
    }

    const mappedModel = getMappedModel("cursor", decoded.model);
    if (!mappedModel) {
      return passthrough(req, res, bodyBuffer);
    }

    log(`[Cursor] intercept ${decoded.model} → ${mappedModel} (${decoded.messages.length} msgs)`);

    const messages = [...decoded.messages];
    if (decoded.instruction) {
      messages.unshift({ role: "system", content: decoded.instruction });
    }

    const openaiBody = {
      model: mappedModel,
      messages,
      stream: true,
    };

    const routerRes = await fetchRouter(openaiBody, "/v1/chat/completions", req.headers);

    if (routerRes.status >= 400) {
      let detail = "";
      try { detail = await routerRes.text(); } catch {}
      throw new Error(`router ${routerRes.status}: ${detail.slice(0, 500)}`);
    }

    res.writeHead(routerRes.status, {
      "Content-Type": "application/connect+proto",
      "connect-protocol-version": "1",
      "Transfer-Encoding": "chunked",
    });

    await pipeOpenAIasConnectRPC(routerRes, res, protobuf);
    log(`[Cursor] response streamed for ${mappedModel}`);
  } catch (error) {
    err(`[Cursor] ${error.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
    }
    try {
      res.end(JSON.stringify({
        error: { message: error.message, type: "mitm_error" },
      }));
    } catch {}
  }
}

module.exports = {
  intercept,
  cursorRequiresPassthrough,
  pipeOpenAIasConnectRPC,
};
