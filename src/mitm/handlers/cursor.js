const { err } = require("../logger");
const { fetchRouter } = require("./base");
const { getMappedModel } = require("../modelMapping");

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

async function pipeOpenAIasConnectRPC(routerRes, res, protobuf) {
  const { encodeTextResponseFrame, encodeToolCallResponseFrame } = protobuf;
  const reader = routerRes.body?.getReader?.();
  if (!reader) {
    const text = await routerRes.text().catch(() => "");
    res.end(text);
    return;
  }

  const decoder = new TextDecoder();
  let buffer = "";
  const toolCalls = new Map();

  // Emit all accumulated tool calls and clear them. Guarded so a flush on
  // finish_reason and the end-of-stream flush can't double-emit.
  const flushToolCalls = () => {
    if (toolCalls.size === 0) return;
    for (const entry of toolCalls.values()) {
      res.write(Buffer.from(encodeToolCallResponseFrame({
        id: entry.id,
        name: entry.name || "tool",
        args: entry.args || "{}",
        isLast: true,
      })));
    }
    toolCalls.clear();
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
        res.write(Buffer.from(encodeTextResponseFrame(delta.content)));
      }

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

      // Flush on ANY finish_reason, not just "tool_calls" — some providers end
      // an agentic turn with finish_reason "stop" while tool calls are pending.
      const finish = chunk?.choices?.[0]?.finish_reason;
      if (finish) {
        flushToolCalls();
      }
    }
  }

  // Safety net: stream closed without a terminal finish_reason.
  flushToolCalls();
  res.end();
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
};
