import { handleChat } from "@/sse/handlers/chat.js";
import { initTranslators, translateRequest } from "open-sse/translator/index.js";
import { FORMATS } from "open-sse/translator/formats.js";
import { VALIDATION_ERROR_TYPES } from "open-sse/utils/error.js";

let initialized = false;

/**
 * Initialize translators once
 */
async function ensureInitialized() {
  if (!initialized) {
    await initTranslators();
    initialized = true;
  }
}

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

/**
 * POST /v1beta/models/{model}:generateContent        — non-streaming
 * POST /v1beta/models/{model}:streamGenerateContent  — streaming (SSE)
 *
 * Streaming intent is determined by the URL action suffix (canonical Gemini API
 * convention), NOT by a body field. generationConfig.stream is not a real
 * Gemini API field and Gemini CLI never sets it.
 *
 * The @google/genai SDK always uses :streamGenerateContent?alt=sse for chat.
 * The upstream handleChat returns OpenAI SSE format; we transform it to
 * Gemini SSE format on the fly via transformOpenAISSEToGeminiSSE().
 */
function parseV1BetaPath(path) {
  if (!path?.length) {
    const err = new Error("Missing model path");
    err.status = 400;
    throw err;
  }

  const modelAction = path[path.length - 1];
  let action;
  if (modelAction.endsWith(":streamGenerateContent")) {
    action = ":streamGenerateContent";
  } else if (modelAction.endsWith(":generateContent")) {
    action = ":generateContent";
  } else {
    const err = new Error(`Unrecognized action suffix in path: ${modelAction}`);
    err.status = 400;
    throw err;
  }
  const modelName = modelAction.slice(0, -action.length);

  if (path.length === 1) {
    return { model: modelName, action };
  }

  const prefix = path.slice(0, -1).join("/");
  return { model: `${prefix}/${modelName}`, action };
}

function geminiErrorResponse(status, message, code) {
  return Response.json(
    { error: { message, code } },
    {
      status,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    }
  );
}

export async function POST(request, { params }) {
  await ensureInitialized();

  try {
    const { path } = await params;
    const { model, action } = parseV1BetaPath(path);

    let body;
    try {
      body = await request.json();
    } catch {
      return geminiErrorResponse(
        400,
        "Invalid JSON body",
        VALIDATION_ERROR_TYPES.VALIDATION_FAILED
      );
    }

    // Streaming is determined by URL action suffix:
    //   :streamGenerateContent => stream: true  (SSE)
    //   :generateContent       => stream: false (plain JSON)
    const stream = action === ":streamGenerateContent";

    let convertedBody;
    try {
      convertedBody = convertGeminiToInternal(body, model, stream);
    } catch (translationError) {
      return geminiErrorResponse(
        400,
        translationError.message || "Request translation failed",
        VALIDATION_ERROR_TYPES.TRANSLATION_INVALID_BODY
      );
    }

    // The body has been converted to OpenAI shape. Build forwarded headers that
    // do NOT carry the Gemini-specific auth/format header: leaving x-goog-api-key
    // on the request makes the core re-detect the converted body as Gemini and
    // double-translate it (dropping the prompt). Promote a Gemini credential
    // (x-goog-api-key or ?key=) to the gateway's x-api-key so standard Gemini SDK
    // auth is accepted under requireApiKey (non-gateway-shaped keys are still
    // ignored/rejected by the auth layer — this does not weaken enforcement).
    const fwdHeaders = new Headers(request.headers);
    let googKey = (request.headers.get("x-goog-api-key") || "").trim();
    if (!googKey) {
      try { googKey = (new URL(request.url).searchParams.get("key") || "").trim(); } catch { /* ignore */ }
    }
    fwdHeaders.delete("x-goog-api-key");
    if (googKey && !fwdHeaders.get("x-api-key") && !fwdHeaders.get("authorization")) {
      fwdHeaders.set("x-api-key", googKey);
    }

    // Create new request with converted body
    const newRequest = new Request(request.url, {
      method: "POST",
      headers: fwdHeaders,
      body: JSON.stringify(convertedBody),
      signal: request.signal,
    });

    const response = await handleChat(newRequest);

    if (stream) {
      // The converted request is translated upstream, so the response is OpenAI
      // SSE (or upstream-native Gemini SSE). peekFirstChunkIsGeminiSSE inside
      // passthroughOrTransformGeminiSSE relays native Gemini frames unchanged and
      // transforms OpenAI frames to Gemini SSE.
      return passthroughOrTransformGeminiSSE(response, model);
    } else {
      // Convert OpenAI JSON response => Gemini GenerateContentResponse
      return await convertOpenAIResponseToGemini(response, model);
    }
  } catch (error) {
    console.log("Error handling Gemini request:", error);
    if (error.status === 400) {
      return geminiErrorResponse(
        400,
        error.message || "Invalid request path",
        VALIDATION_ERROR_TYPES.VALIDATION_FAILED
      );
    }
    return geminiErrorResponse(500, error.message, 500);
  }
}

/**
 * Convert Gemini request format to OpenAI/internal format.
 *
 * @param {object} geminiBody  - parsed Gemini request body
 * @param {string} model       - resolved model string (e.g. "gemini-pro-high")
 * @param {boolean} stream     - whether to stream (from URL action)
 */
function convertGeminiToInternal(geminiBody, model, stream) {
  return translateRequest(FORMATS.GEMINI, FORMATS.OPENAI, model, geminiBody, stream);
}

function withGeminiStreamHeaders(response) {
  if (!response.ok) return response;
  const headers = new Headers(response.headers);
  headers.set("Content-Type", "text/event-stream");
  headers.set("Cache-Control", "no-cache");
  headers.set("Access-Control-Allow-Origin", "*");
  return new Response(response.body, { status: response.status, headers });
}

async function peekFirstChunkIsGeminiSSE(peekStream) {
  const reader = peekStream.getReader();
  let decoded = "";
  try {
    while (decoded.length < 8192) {
      const { done, value } = await reader.read();
      if (done) break;
      decoded += new TextDecoder().decode(value, { stream: true });
      if (/data:\s*\S/.test(decoded)) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return /"candidates"\s*:/.test(decoded);
}

async function passthroughOrTransformGeminiSSE(upstreamResponse, model) {
  if (!upstreamResponse.ok || !upstreamResponse.body) {
    return upstreamResponse;
  }

  const [peek, main] = upstreamResponse.body.tee();
  const isNativeGemini = await peekFirstChunkIsGeminiSSE(peek);
  if (isNativeGemini) {
    return withGeminiStreamHeaders(new Response(main, { status: upstreamResponse.status }));
  }

  return transformOpenAISSEToGeminiSSE(
    new Response(main, { status: upstreamResponse.status, headers: upstreamResponse.headers }),
    model
  );
}

/** Map OpenAI finish_reason => Gemini finishReason */
const FINISH_REASON_MAP = {
  stop: "STOP",
  length: "MAX_TOKENS",
  tool_calls: "STOP",
  content_filter: "SAFETY",
};

/**
 * Transform an OpenAI SSE stream into a Gemini SSE stream.
 *
 * OpenAI SSE format (what handleChat returns):
 *   data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}
 *   data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{...}}
 *   data: [DONE]
 *
 * Gemini SSE format (what @google/genai SDK expects):
 *   data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Hi"}]},"index":0}]}
 *   data: {"candidates":[{"content":{"role":"model","parts":[{"text":""}]},"finishReason":"STOP","index":0}],"usageMetadata":{...}}
 *   (stream closes — no [DONE])
 */
function transformOpenAISSEToGeminiSSE(upstreamResponse, model) {
  if (!upstreamResponse.ok || !upstreamResponse.body) {
    return upstreamResponse;
  }

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  let sawTerminal = false;
  let consecutiveParseFailures = 0;
  let lineBuffer = "";
  const MAX_CONSECUTIVE_PARSE_FAILURES = 3;
  const toolCallAccum = {};

  const processLine = (line, controller) => {
    if (!line.startsWith("data:")) return true;

    const data = line.slice(5).trim();

    // Drop empty lines and the OpenAI [DONE] sentinel.
    // Gemini SSE ends by stream close, no sentinel needed.
    if (!data || data === "[DONE]") {
      if (data === "[DONE]") sawTerminal = true;
      return true;
    }

    let parsed;
    try {
      parsed = JSON.parse(data);
      consecutiveParseFailures = 0;
    } catch {
      consecutiveParseFailures++;
      if (consecutiveParseFailures >= MAX_CONSECUTIVE_PARSE_FAILURES) {
        controller.error(new Error("Malformed SSE data after consecutive parse failures"));
        return false;
      }
      return true;
    }

    const choice = parsed.choices?.[0];
    if (!choice) return true;

    const delta = choice.delta || {};

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        if (!toolCallAccum[idx]) {
          toolCallAccum[idx] = { id: "", name: "", arguments: "" };
        }
        const accum = toolCallAccum[idx];
        if (tc.id) accum.id = tc.id;
        if (tc.function?.name) accum.name += tc.function.name;
        if (tc.function?.arguments) accum.arguments += tc.function.arguments;
      }
    }

    const parts = [];
    if (delta.reasoning_content) {
      parts.push({ text: delta.reasoning_content, thought: true });
    }
    if (delta.content) {
      parts.push({ text: delta.content });
    }

    if (choice.finish_reason) {
      for (const idx of Object.keys(toolCallAccum)) {
        const accum = toolCallAccum[idx];
        let args = {};
        try {
          args = JSON.parse(accum.arguments || "{}");
        } catch {
          /* empty */
        }
        parts.push({
          functionCall: {
            name: accum.name,
            args,
          },
        });
      }
    }

    // Skip pure role-only deltas with no content and no finish signal
    if (parts.length === 0 && !choice.finish_reason) return true;

    const candidate = {
      content: {
        role: "model",
        parts: parts.length > 0 ? parts : [{ text: "" }],
      },
      index: 0,
    };

    if (choice.finish_reason) {
      candidate.finishReason = FINISH_REASON_MAP[choice.finish_reason] || "STOP";
      sawTerminal = true;
    }

    const geminiChunk = { candidates: [candidate] };

    // Attach usage + modelVersion on the final chunk (when finish_reason is set)
    if (choice.finish_reason && parsed.usage) {
      geminiChunk.usageMetadata = {
        promptTokenCount: parsed.usage.prompt_tokens || 0,
        candidatesTokenCount: parsed.usage.completion_tokens || 0,
        totalTokenCount: parsed.usage.total_tokens || 0,
      };
      const reasoningTokens =
        parsed.usage.completion_tokens_details?.reasoning_tokens;
      if (reasoningTokens) {
        geminiChunk.usageMetadata.thoughtsTokenCount = reasoningTokens;
      }
      geminiChunk.modelVersion = parsed.model || model;
    }

    controller.enqueue(
      encoder.encode("data: " + JSON.stringify(geminiChunk) + "\r\n\r\n")
    );
    return true;
  };

  const transformStream = new TransformStream({
    transform(chunk, controller) {
      lineBuffer += decoder.decode(chunk, { stream: true });
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!processLine(line, controller)) return;
      }
    },
    flush(controller) {
      lineBuffer += decoder.decode();
      if (lineBuffer.trim() && !processLine(lineBuffer, controller)) return;
      if (!sawTerminal) {
        controller.error(new Error("Stream ended without terminal completion chunk"));
      }
    },
  });

  return new Response(upstreamResponse.body.pipeThrough(transformStream), {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Convert an OpenAI chat.completion JSON response into a Gemini
 * GenerateContentResponse so that Gemini CLI can parse it.
 */
async function convertOpenAIResponseToGemini(response, model) {
  if (!response.ok) return response;

  let body;
  try {
    body = await response.json();
  } catch {
    return response;
  }

  if (body.candidates) return Response.json(body, {
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });

  if (body.error) return Response.json(body, {
    status: response.status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });

  const choice = body.choices?.[0];
  if (!choice) {
    return Response.json(
      { error: { message: "Upstream returned empty completion", type: "server_error", code: "empty_completion" } },
      { status: 502, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
    );
  }

  const { message, finish_reason } = choice;

  const parts = [];
  if (message.reasoning_content) {
    parts.push({ text: message.reasoning_content, thought: true });
  }
  if (message.content) {
    parts.push({ text: message.content });
  }
  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      let args = {};
      try {
        args = JSON.parse(tc.function?.arguments || "{}");
      } catch {
        /* empty */
      }
      parts.push({
        functionCall: {
          name: tc.function?.name || "",
          args,
        },
      });
    }
  }
  if (parts.length === 0) {
    parts.push({ text: "" });
  }

  const finishReason = FINISH_REASON_MAP[finish_reason] || "STOP";

  const geminiResponse = {
    candidates: [
      {
        content: { role: "model", parts },
        finishReason,
        index: 0,
      },
    ],
    modelVersion: body.model || model,
  };

  if (body.usage) {
    geminiResponse.usageMetadata = {
      promptTokenCount: body.usage.prompt_tokens || 0,
      candidatesTokenCount: body.usage.completion_tokens || 0,
      totalTokenCount: body.usage.total_tokens || 0,
    };
    const reasoningTokens = body.usage.completion_tokens_details?.reasoning_tokens;
    if (reasoningTokens) {
      geminiResponse.usageMetadata.thoughtsTokenCount = reasoningTokens;
    }
  }

  return Response.json(geminiResponse, {
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}
