import { FORMATS } from "../../translator/formats.js";
import { needsTranslation } from "../../translator/index.js";
import { ollamaBodyToOpenAI } from "../../translator/response/ollama-to-openai.js";
import { addBufferToUsage, filterUsageForFormat } from "../../utils/usageTracking.js";
import { createErrorResult } from "../../utils/error.js";
import { HTTP_STATUS } from "../../config/runtimeConfig.js";
import { parseSSEToOpenAIResponse } from "./sseToJsonHandler.js";
import { buildRequestDetail, extractRequestConfig, extractUsageFromResponse, saveUsageStats } from "./requestDetail.js";
import { appendRequestLog, saveRequestDetail } from "@/lib/usageDb.js";
import { decloakToolNames } from "../../utils/claudeCloaking.js";

/**
 * Translate non-streaming response body from provider format → client's source format.
 * Two-step: targetFormat → OpenAI intermediate → sourceFormat
 * Returns the response in the client's expected format.
 */
export function translateNonStreamingResponse(responseBody, targetFormat, sourceFormat) {
  if (targetFormat === sourceFormat) return responseBody;

  // Step 1: target → OpenAI intermediate (if target is not already OpenAI)
  let openaiResponse = responseBody;
  if (targetFormat !== FORMATS.OPENAI) {
    openaiResponse = translateTargetToOpenAI(responseBody, targetFormat);
  }

  // Step 2: OpenAI → source format (if source is not OpenAI)
  if (sourceFormat !== FORMATS.OPENAI) {
    return translateOpenAIToSource(openaiResponse, sourceFormat);
  }

  return openaiResponse;
}

/**
 * Step 1: Translate provider (target) response body to OpenAI format.
 */
function translateTargetToOpenAI(responseBody, targetFormat) {

  // Gemini / Antigravity
  if (targetFormat === FORMATS.GEMINI || targetFormat === FORMATS.ANTIGRAVITY || targetFormat === FORMATS.GEMINI_CLI || targetFormat === FORMATS.VERTEX) {
    const response = responseBody.response || responseBody;
    if (!response?.candidates?.[0]) return responseBody;

    const candidate = response.candidates[0];
    const content = candidate.content;
    const usage = response.usageMetadata || responseBody.usageMetadata;
    let textContent = "", reasoningContent = "";
    const toolCalls = [];

    if (content?.parts) {
      for (const part of content.parts) {
        if (part.thought === true && part.text) reasoningContent += part.text;
        else if (part.text !== undefined) textContent += part.text;
        if (part.functionCall) {
          toolCalls.push({
            id: `call_${part.functionCall.name}_${Date.now()}_${toolCalls.length}`,
            type: "function",
            function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args || {}) }
          });
        }
      }
    }

    const message = { role: "assistant" };
    if (textContent) message.content = textContent;
    if (reasoningContent) message.reasoning_content = reasoningContent;
    if (toolCalls.length > 0) message.tool_calls = toolCalls;
    if (!message.content && !message.tool_calls) message.content = "";

    let finishReason = (candidate.finishReason || "stop").toLowerCase();
    if (finishReason === "stop" && toolCalls.length > 0) finishReason = "tool_calls";

    const result = {
      id: `chatcmpl-${response.responseId || Date.now()}`,
      object: "chat.completion",
      created: Math.floor(new Date(response.createTime || Date.now()).getTime() / 1000),
      model: response.modelVersion || "gemini",
      choices: [{ index: 0, message, finish_reason: finishReason }]
    };

    if (usage) {
      result.usage = {
        prompt_tokens: (usage.promptTokenCount || 0) + (usage.thoughtsTokenCount || 0),
        completion_tokens: usage.candidatesTokenCount || 0,
        total_tokens: usage.totalTokenCount || 0
      };
      if (usage.thoughtsTokenCount > 0) {
        result.usage.completion_tokens_details = { reasoning_tokens: usage.thoughtsTokenCount };
      }
    }
    return result;
  }

  // Claude
  if (targetFormat === FORMATS.CLAUDE) {
    if (!responseBody.content) return responseBody;

    let textContent = "", thinkingContent = "";
    const toolCalls = [];

    for (const block of responseBody.content) {
      if (block.type === "text") {
        // Strip markdown code block markers (e.g. kimi wraps JSON in ```json...```)
        const raw = block.text ?? "";
        const text = raw.replace(/^\s*```\s*json\s*\n?/i, "").replace(/\n?\s*```\s*$/i, "");
        textContent += text;
      } else if (block.type === "thinking") thinkingContent += block.thinking || "";
      else if (block.type === "tool_use") {
        toolCalls.push({ id: block.id, type: "function", function: { name: block.name, arguments: JSON.stringify(block.input || {}) } });
      }
    }

    const message = { role: "assistant" };
    if (textContent) message.content = textContent;
    if (thinkingContent) message.reasoning_content = thinkingContent;
    if (toolCalls.length > 0) message.tool_calls = toolCalls;
    if (!message.content && !message.tool_calls) message.content = "";

    let finishReason = responseBody.stop_reason || "stop";
    if (finishReason === "end_turn") finishReason = "stop";
    if (finishReason === "tool_use") finishReason = "tool_calls";

    const result = {
      id: `chatcmpl-${responseBody.id || Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: responseBody.model || "claude",
      choices: [{ index: 0, message, finish_reason: finishReason }]
    };

    if (responseBody.usage) {
      result.usage = {
        prompt_tokens: responseBody.usage.input_tokens || 0,
        completion_tokens: responseBody.usage.output_tokens || 0,
        total_tokens: (responseBody.usage.input_tokens || 0) + (responseBody.usage.output_tokens || 0)
      };
    }
    return result;
  }

  // Ollama
  if (targetFormat === FORMATS.OLLAMA) {
    return ollamaBodyToOpenAI(responseBody);
  }

  return responseBody;
}

/**
 * Step 2: Translate OpenAI format response to client's source format.
 * For non-streaming, this converts the complete OpenAI JSON into the source format.
 */
function translateOpenAIToSource(openaiResponse, sourceFormat) {
  // Claude source format: convert to Claude Messages API response
  if (sourceFormat === FORMATS.CLAUDE) {
    const choice = openaiResponse.choices?.[0];
    if (!choice) return openaiResponse;

    const msg = choice.message || {};
    const content = [];

    // Add thinking/reasoning content
    if (msg.reasoning_content) {
      content.push({ type: "thinking", thinking: msg.reasoning_content });
    }

    // Add text content
    if (msg.content) {
      content.push({ type: "text", text: msg.content });
    }

    // Add tool_use blocks
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        let input = {};
        try { input = JSON.parse(tc.function?.arguments || "{}"); } catch { /* empty */ }
        content.push({
          type: "tool_use",
          id: tc.id || `toolu_${Date.now()}`,
          name: tc.function?.name || "",
          input
        });
      }
    }

    // If no content blocks, add empty text
    if (content.length === 0) {
      content.push({ type: "text", text: "" });
    }

    // Map finish_reason to stop_reason
    let stopReason = "end_turn";
    if (choice.finish_reason === "tool_calls") stopReason = "tool_use";
    else if (choice.finish_reason === "length") stopReason = "max_tokens";

    const result = {
      id: openaiResponse.id?.replace("chatcmpl-", "msg_") || `msg_${Date.now()}`,
      type: "message",
      role: "assistant",
      model: openaiResponse.model || "unknown",
      content,
      stop_reason: stopReason,
      stop_sequence: null
    };

    if (openaiResponse.usage) {
      result.usage = {
        input_tokens: openaiResponse.usage.prompt_tokens || 0,
        output_tokens: openaiResponse.usage.completion_tokens || 0
      };
      if (openaiResponse.usage.prompt_tokens_details?.cached_tokens) {
        result.usage.cache_read_input_tokens = openaiResponse.usage.prompt_tokens_details.cached_tokens;
      }
    }

    return result;
  }

  // Gemini / Gemini CLI source format: convert to Gemini response
  if (sourceFormat === FORMATS.GEMINI || sourceFormat === FORMATS.GEMINI_CLI) {
    const choice = openaiResponse.choices?.[0];
    if (!choice) return openaiResponse;

    const msg = choice.message || {};
    const parts = [];

    // Add thinking/reasoning as thought parts
    if (msg.reasoning_content) {
      parts.push({ thought: true, text: msg.reasoning_content });
    }

    // Add text content
    if (msg.content) {
      parts.push({ text: msg.content });
    }

    // Add tool calls as functionCall parts
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        let args = {};
        try { args = JSON.parse(tc.function?.arguments || "{}"); } catch { /* empty */ }
        parts.push({
          functionCall: {
            name: tc.function?.name || "",
            args
          }
        });
      }
    }

    // Ensure at least one part
    if (parts.length === 0) {
      parts.push({ text: "" });
    }

    // Map finish_reason
    let finishReason = "STOP";
    if (choice.finish_reason === "length") finishReason = "MAX_TOKENS";
    else if (choice.finish_reason === "content_filter") finishReason = "SAFETY";

    const result = {
      candidates: [{ content: { role: "model", parts }, finishReason }],
      modelVersion: openaiResponse.model || "unknown",
      responseId: openaiResponse.id || `resp_${Date.now()}`
    };

    if (openaiResponse.usage) {
      result.usageMetadata = {
        promptTokenCount: openaiResponse.usage.prompt_tokens || 0,
        candidatesTokenCount: openaiResponse.usage.completion_tokens || 0,
        totalTokenCount: openaiResponse.usage.total_tokens || 0
      };
      if (openaiResponse.usage.completion_tokens_details?.reasoning_tokens) {
        result.usageMetadata.thoughtsTokenCount = openaiResponse.usage.completion_tokens_details.reasoning_tokens;
      }
      if (openaiResponse.usage.prompt_tokens_details?.cached_tokens) {
        result.usageMetadata.cachedContentTokenCount = openaiResponse.usage.prompt_tokens_details.cached_tokens;
      }
    }

    return result;
  }

  // Antigravity source format: wrap Gemini response in { response: ... }
  if (sourceFormat === FORMATS.ANTIGRAVITY) {
    const choice = openaiResponse.choices?.[0];
    if (!choice) return openaiResponse;

    const msg = choice.message || {};
    const parts = [];

    if (msg.reasoning_content) {
      parts.push({ thought: true, text: msg.reasoning_content });
    }
    if (msg.content) {
      parts.push({ text: msg.content });
    }
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        let args = {};
        try { args = JSON.parse(tc.function?.arguments || "{}"); } catch { /* empty */ }
        parts.push({ functionCall: { name: tc.function?.name || "", args } });
      }
    }
    if (parts.length === 0) {
      parts.push({ text: "" });
    }

    let finishReason = "STOP";
    if (choice.finish_reason === "length") finishReason = "MAX_TOKENS";
    else if (choice.finish_reason === "content_filter") finishReason = "SAFETY";

    const geminiBody = {
      candidates: [{ content: { role: "model", parts }, finishReason }],
      modelVersion: openaiResponse.model || "unknown",
      responseId: openaiResponse.id || `resp_${Date.now()}`
    };

    if (openaiResponse.usage) {
      geminiBody.usageMetadata = {
        promptTokenCount: openaiResponse.usage.prompt_tokens || 0,
        candidatesTokenCount: openaiResponse.usage.completion_tokens || 0,
        totalTokenCount: openaiResponse.usage.total_tokens || 0
      };
      if (openaiResponse.usage.completion_tokens_details?.reasoning_tokens) {
        geminiBody.usageMetadata.thoughtsTokenCount = openaiResponse.usage.completion_tokens_details.reasoning_tokens;
      }
    }

    return { response: geminiBody };
  }

  // For other source formats (openai-responses, kiro, cursor, ollama, commandcode, etc.)
  // that don't have a dedicated non-streaming reverse translator, return OpenAI format.
  // These formats are either:
  // - Always streaming (Kiro, Cursor, Ollama, CommandCode clients forced streaming)
  // - Already handled by dedicated paths (OpenAI-Responses via sseToJsonHandler)
  return openaiResponse;
}

/**
 * Handle non-streaming response from provider.
 */
export async function handleNonStreamingResponse({ providerResponse, provider, model, sourceFormat, targetFormat, body, stream, translatedBody, finalBody, requestStartTime, connectionId, apiKey, clientRawRequest, onRequestSuccess, reqLogger, toolNameMap, trackDone, appendLog, passthrough }) {
  trackDone();
  const contentType = providerResponse.headers.get("content-type") || "";
  let responseBody;
  // Flag: true when the response was parsed from an SSE stream and is already in
  // OpenAI chat-completion format. Prevents re-running the targetFormat→OpenAI step
  // (step 1 of translateNonStreamingResponse) on a body that is already OpenAI format.
  let parsedFromSSE = false;

  if (contentType.includes("text/event-stream")) {
    const sseText = await providerResponse.text();
    const parsed = parseSSEToOpenAIResponse(sseText, model);
    if (!parsed) {
      appendLog({ status: `FAILED ${HTTP_STATUS.BAD_GATEWAY}` });
      return createErrorResult(HTTP_STATUS.BAD_GATEWAY, "Invalid SSE response for non-streaming request");
    }
    responseBody = parsed;
    parsedFromSSE = true;
  } else {
    try {
      responseBody = await providerResponse.json();
    } catch (err) {
      appendLog({ status: `FAILED ${HTTP_STATUS.BAD_GATEWAY}` });
      console.error(`[ChatCore] Failed to parse JSON from ${provider}:`, err.message);
      return createErrorResult(HTTP_STATUS.BAD_GATEWAY, `Invalid JSON response from ${provider}`);
    }
  }

  reqLogger.logProviderResponse(providerResponse.status, providerResponse.statusText, providerResponse.headers, responseBody);
  if (onRequestSuccess) await onRequestSuccess();

  // Decloak tool_use names once on raw Claude body, before any translation (INPUT side)
  // In passthrough mode, toolNameMap is null (no cloaking happened), so this is a no-op.
  responseBody = decloakToolNames(responseBody, toolNameMap);

  const usage = extractUsageFromResponse(responseBody);
  appendLog({ tokens: usage, status: "200 OK" });
  saveUsageStats({ provider, model, tokens: usage, connectionId, apiKey, endpoint: clientRawRequest?.endpoint });

  // PASSTHROUGH GUARD: In passthrough mode, preserve the upstream response shape as-is.
  // Do NOT translate, normalize, strip fields, or inject OpenAI-required fields.
  // Only model + auth were swapped on the request side; the response is relayed untouched.
  if (passthrough) {
    reqLogger.logConvertedResponse(responseBody);

    const totalLatency = Date.now() - requestStartTime;
    saveRequestDetail(buildRequestDetail({
      provider, model, connectionId,
      latency: { ttft: totalLatency, total: totalLatency },
      tokens: usage || { prompt_tokens: 0, completion_tokens: 0 },
      request: extractRequestConfig(body, stream),
      providerRequest: finalBody || translatedBody || null,
      providerResponse: responseBody || null,
      response: {
        content: responseBody?.choices?.[0]?.message?.content || responseBody?.content?.[0]?.text || null,
        thinking: null,
        finish_reason: responseBody?.choices?.[0]?.finish_reason || responseBody?.stop_reason || "unknown"
      },
      status: "success"
    }, { endpoint: clientRawRequest?.endpoint || null })).catch(err => {
      console.error("[RequestDetail] Failed to save:", err.message);
    });

    return {
      success: true,
      response: new Response(JSON.stringify(responseBody), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      })
    };
  }

  // When the body was parsed from SSE it is already in OpenAI format.
  // Only run step 2 (OpenAI → sourceFormat) if necessary; skip step 1 (targetFormat → OpenAI)
  // which would misinterpret the already-OpenAI body as a targetFormat-shaped response.
  const translatedResponse = parsedFromSSE
    ? translateNonStreamingResponse(responseBody, FORMATS.OPENAI, sourceFormat)
    : (needsTranslation(targetFormat, sourceFormat)
        ? translateNonStreamingResponse(responseBody, targetFormat, sourceFormat)
        : responseBody);

  // Fix finish_reason for tool_calls: some providers return non-standard values (e.g. "other")
  if (translatedResponse?.choices?.[0]) {
    const choice = translatedResponse.choices[0];
    const msg = choice.message;
    const hasToolCalls = Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0;
    if (hasToolCalls && choice.finish_reason !== "tool_calls") {
      choice.finish_reason = "tool_calls";
    }
  }

  // Ensure OpenAI-required fields
  if (!translatedResponse.object) translatedResponse.object = "chat.completion";
  if (!translatedResponse.created) translatedResponse.created = Math.floor(Date.now() / 1000);

  // Strip Azure-specific fields
  delete translatedResponse.prompt_filter_results;
  if (translatedResponse?.choices) {
    for (const choice of translatedResponse.choices) delete choice.content_filter_results;
  }

  if (translatedResponse?.usage) {
    translatedResponse.usage = filterUsageForFormat(addBufferToUsage(translatedResponse.usage), sourceFormat);
  }

  // Strip reasoning_content — some clients (e.g. Firecrawl AI SDK) have JSON parsers that
  // break on this non-standard field, even though OpenAI allows it in extensions.
  if (translatedResponse?.choices) {
    for (const choice of translatedResponse.choices) {
      if (choice?.message) delete choice.message.reasoning_content;
    }
  }

  reqLogger.logConvertedResponse(translatedResponse);

  const totalLatency = Date.now() - requestStartTime;
  saveRequestDetail(buildRequestDetail({
    provider, model, connectionId,
    latency: { ttft: totalLatency, total: totalLatency },
    tokens: usage || { prompt_tokens: 0, completion_tokens: 0 },
    request: extractRequestConfig(body, stream),
    providerRequest: finalBody || translatedBody || null,
    providerResponse: responseBody || null,
    response: {
      content: translatedResponse?.choices?.[0]?.message?.content || translatedResponse?.content || null,
      thinking: translatedResponse?.choices?.[0]?.message?.reasoning_content || translatedResponse?.reasoning_content || null,
      finish_reason: translatedResponse?.choices?.[0]?.finish_reason || "unknown"
    },
    status: "success"
  }, { endpoint: clientRawRequest?.endpoint || null })).catch(err => {
    console.error("[RequestDetail] Failed to save:", err.message);
  });

  return {
    success: true,
    response: new Response(JSON.stringify(translatedResponse), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    })
  };
}
