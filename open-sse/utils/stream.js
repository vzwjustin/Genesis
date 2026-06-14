import { translateResponse, initState } from "../translator/index.js";
import { FORMATS } from "../translator/formats.js";
import { appendRequestLog } from "@/lib/usageDb.js";
import { extractUsage, hasValidUsage, estimateUsage, logUsage, addBufferToUsage, filterUsageForFormat, COLORS } from "./usageTracking.js";
import { parseSSELine, hasValuableContent, fixInvalidId, formatSSE, MalformedSSEDataError } from "./streamHelpers.js";
import { dbg, isDebugEnabled } from "./debugLog.js";

export { COLORS, formatSSE };

// sharedEncoder is stateless — safe to share across streams
const sharedEncoder = new TextEncoder();

/**
 * Stream modes
 */
const STREAM_MODE = {
  TRANSLATE: "translate",    // Full translation between formats
  PASSTHROUGH: "passthrough" // No translation, normalize output, extract usage
};

/**
 * Create unified SSE transform stream
 * @param {object} options
 * @param {string} options.mode - Stream mode: translate, passthrough
 * @param {string} options.targetFormat - Provider format (for translate mode)
 * @param {string} options.sourceFormat - Client format (for translate mode)
 * @param {string} options.provider - Provider name
 * @param {object} options.reqLogger - Request logger instance
 * @param {string} options.model - Model name
 * @param {string} options.connectionId - Connection ID for usage tracking
 * @param {object} options.body - Request body (for input token estimation)
 * @param {function} options.onStreamComplete - Callback when stream completes (content, usage)
 * @param {function} [options.onPendingRelease] - Called once when the transform stream flushes
 * @param {string} options.apiKey - API key for usage tracking
 */
export function createSSEStream(options = {}) {
  const {
    mode = STREAM_MODE.TRANSLATE,
    targetFormat,
    sourceFormat,
    provider = null,
    reqLogger = null,
    toolNameMap = null,
    model = null,
    connectionId = null,
    body = null,
    onStreamComplete = null,
    onPendingRelease = null,
    apiKey = null
  } = options;

  let buffer = "";
  let usage = null;

  // Per-stream decoder with stream:true to correctly handle multi-byte chars split across chunks
  const decoder = new TextDecoder("utf-8", { fatal: false });

  const state = mode === STREAM_MODE.TRANSLATE ? { ...initState(sourceFormat), provider, toolNameMap, model } : null;

  let totalContentLength = 0;
  let accumulatedContent = "";
  let accumulatedThinking = "";
  let ttftAt = null;
  let sseLineCount = 0;
  let sseEmittedCount = 0;
  let sawTerminal = false;
  let doneAlreadyForwarded = false;
  const eventTypeCounts = {};

  const maybeEmitDone = (controller) => {
    if (sourceFormat === FORMATS.OPENAI && sawTerminal && !doneAlreadyForwarded) {
      const doneOutput = "data: [DONE]\n\n";
      reqLogger?.appendConvertedChunk?.(doneOutput);
      controller.enqueue(sharedEncoder.encode(doneOutput));
      doneAlreadyForwarded = true;
    }
  };

  const markTerminalFromParsed = (parsed) => {
    if (!parsed) return;
    if (parsed.done) sawTerminal = true;
    if (parsed.type === "message_stop") sawTerminal = true;
    if (parsed.choices?.[0]?.finish_reason) sawTerminal = true;
    if (parsed.candidates?.[0]?.finishReason) sawTerminal = true;
  };

  const markTerminalFromTranslated = (items) => {
    if (!items?.length) return;
    for (const item of items) {
      if (item?.type === "message_stop") sawTerminal = true;
      if (item?.choices?.[0]?.finish_reason) sawTerminal = true;
      if (item?.type === "response.completed") sawTerminal = true;
    }
  };

  const markTerminalFromState = () => {
    if (state?.finishReason || state?.finishReasonSent) sawTerminal = true;
  };

  const processPassthroughDataLine = (trimmed) => {
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") {
      sawTerminal = true;
      doneAlreadyForwarded = true;
      return;
    }
    if (!payload) return;
    try {
      const parsed = JSON.parse(payload);
      markTerminalFromParsed(parsed);
      const delta = parsed.choices?.[0]?.delta;
      if (delta?.content && typeof delta.content === "string") {
        totalContentLength += delta.content.length;
        accumulatedContent += delta.content;
      }
      if (delta?.reasoning_content && typeof delta.reasoning_content === "string") {
        totalContentLength += delta.reasoning_content.length;
        accumulatedThinking += delta.reasoning_content;
      }
      if (parsed.type === "content_block_delta" && parsed.delta?.type === "text_delta" && typeof parsed.delta.text === "string") {
        totalContentLength += parsed.delta.text.length;
        accumulatedContent += parsed.delta.text;
      }
      if (parsed.type === "content_block_delta" && parsed.delta?.type === "thinking_delta" && typeof parsed.delta.thinking === "string") {
        totalContentLength += parsed.delta.thinking.length;
        accumulatedThinking += parsed.delta.thinking;
      }
      const geminiBody = parsed.response || parsed;
      if (geminiBody.candidates?.[0]?.content?.parts) {
        for (const part of geminiBody.candidates[0].content.parts) {
          if (part.text && typeof part.text === "string") {
            totalContentLength += part.text.length;
            if (part.thought === true) {
              accumulatedThinking += part.text;
            } else {
              accumulatedContent += part.text;
            }
          }
        }
      }
      const extracted = extractUsage(parsed);
      if (extracted) usage = extracted;
    } catch { /* non-JSON passthrough lines are forwarded as-is */ }
  };

  return new TransformStream({
    transform(chunk, controller) {
      if (!ttftAt) ttftAt = Date.now();
      const text = decoder.decode(chunk, { stream: true });
      buffer += text;
      reqLogger?.appendProviderChunk?.(text);

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (isDebugEnabled && trimmed) {
          sseLineCount++;
          if (trimmed.startsWith("event:")) {
            const evt = trimmed.slice(6).trim();
            eventTypeCounts[evt] = (eventTypeCounts[evt] || 0) + 1;
          }
        }

        // Passthrough mode: byte-forward upstream SSE (usage accounting only, no mutation)
        if (mode === STREAM_MODE.PASSTHROUGH) {
          processPassthroughDataLine(trimmed);

          let output;
          if (line.startsWith("data:") && !line.startsWith("data: ")) {
            output = "data: " + line.slice(5) + "\n";
          } else {
            output = line + "\n";
          }

          reqLogger?.appendConvertedChunk?.(output);
          controller.enqueue(sharedEncoder.encode(output));
          continue;
        }

        // Translate mode
        if (!trimmed) continue;

        const parsed = parseSSELine(trimmed, targetFormat, { failOnMalformedData: true });
        if (!parsed) continue;

        // For Ollama: done=true is the final chunk with finish_reason/usage, must translate
        // For other formats: done=true is the [DONE] sentinel, skip
        if (parsed && parsed.done && targetFormat !== FORMATS.OLLAMA) {
          sawTerminal = true;
          if (!doneAlreadyForwarded) {
            const output = "data: [DONE]\n\n";
            reqLogger?.appendConvertedChunk?.(output);
            controller.enqueue(sharedEncoder.encode(output));
            doneAlreadyForwarded = true;
          }
          continue;
        }

        markTerminalFromParsed(parsed);

        // Claude format - content
        if (parsed.delta?.text) {
          totalContentLength += parsed.delta.text.length;
          accumulatedContent += parsed.delta.text;
        }
        // Claude format - thinking
        if (parsed.delta?.thinking) {
          totalContentLength += parsed.delta.thinking.length;
          accumulatedThinking += parsed.delta.thinking;
        }
        
        // OpenAI format - content
        if (parsed.choices?.[0]?.delta?.content) {
          totalContentLength += parsed.choices[0].delta.content.length;
          accumulatedContent += parsed.choices[0].delta.content;
        }
        // OpenAI format - reasoning
        if (parsed.choices?.[0]?.delta?.reasoning_content) {
          totalContentLength += parsed.choices[0].delta.reasoning_content.length;
          accumulatedThinking += parsed.choices[0].delta.reasoning_content;
        }
        
        // Gemini format
        if (parsed.candidates?.[0]?.content?.parts) {
          for (const part of parsed.candidates[0].content.parts) {
            if (part.text && typeof part.text === "string") {
              totalContentLength += part.text.length;
              // Check if this is thinking content
              if (part.thought === true) {
                accumulatedThinking += part.text;
              } else {
                accumulatedContent += part.text;
              }
            }
          }
        }

        // Extract usage
        const extracted = extractUsage(parsed);
        if (extracted) state.usage = extracted; // Keep original usage for logging

        // Translate: targetFormat -> openai -> sourceFormat
        const translated = translateResponse(targetFormat, sourceFormat, parsed, state);
        markTerminalFromState();
        markTerminalFromTranslated(translated);

        // Log OpenAI intermediate chunks (if available)
        if (translated?._openaiIntermediate) {
          for (const item of translated._openaiIntermediate) {
            const openaiOutput = formatSSE(item, FORMATS.OPENAI);
            reqLogger?.appendOpenAIChunk?.(openaiOutput);
          }
        }

        if (translated?.length > 0) {
          for (const item of translated) {
            // Filter empty chunks
            if (!hasValuableContent(item, sourceFormat)) {
              continue; // Skip this empty chunk
            }

            // Inject estimated usage if finish chunk has no valid usage
            const isFinishChunk = item.type === "message_delta" || item.choices?.[0]?.finish_reason;
            if (state.finishReason && isFinishChunk && !hasValidUsage(item.usage) && totalContentLength > 0) {
              const estimated = estimateUsage(body, totalContentLength, sourceFormat);
              item.usage = filterUsageForFormat(estimated, sourceFormat); // Filter + already has buffer
              state.usage = estimated;
            } else if (state.finishReason && isFinishChunk && state.usage) {
              // Add buffer and filter usage for client (but keep original in state.usage for logging)
              const buffered = addBufferToUsage(state.usage);
              item.usage = filterUsageForFormat(buffered, sourceFormat);
            }

            const output = formatSSE(item, sourceFormat);
            reqLogger?.appendConvertedChunk?.(output);
            controller.enqueue(sharedEncoder.encode(output));
            sseEmittedCount++;
          }
        }
      }
    },

    async flush(controller) {
      const evtSummary = Object.entries(eventTypeCounts).map(([k, v]) => `${k}=${v}`).join(",") || "none";
      dbg("SSE", `flush | provider=${provider} | model=${model} | recvLines=${sseLineCount} | emitted=${sseEmittedCount} | events=[${evtSummary}]`);
      try {
        try { onPendingRelease?.(); } catch (releaseErr) { console.error("onPendingRelease error:", releaseErr); }
        const remaining = decoder.decode();
        if (remaining) buffer += remaining;

        if (mode === STREAM_MODE.PASSTHROUGH) {
          if (buffer.trim()) {
            processPassthroughDataLine(buffer.trim());
            let output = buffer;
            if (buffer.startsWith("data:") && !buffer.startsWith("data: ")) {
              output = "data: " + buffer.slice(5);
            }
            if (!output.endsWith("\n\n")) {
              output += output.endsWith("\n") ? "\n" : "\n\n";
            }
            reqLogger?.appendConvertedChunk?.(output);
            controller.enqueue(sharedEncoder.encode(output));
          }

          if (!hasValidUsage(usage) && totalContentLength > 0) {
            usage = estimateUsage(body, totalContentLength, sourceFormat || FORMATS.OPENAI);
          }

          if (hasValidUsage(usage) && !onStreamComplete) {
            logUsage(provider, usage, model, connectionId, apiKey);
          } else if (!hasValidUsage(usage)) {
            appendRequestLog({ model, provider, connectionId, tokens: null, status: "200 OK" }).catch(() => { });
          }
          
          // Passthrough relay: emit [DONE] only when upstream signalled terminal
          // and did not already forward [DONE].
          maybeEmitDone(controller);

          if (onStreamComplete) {
            onStreamComplete({
              content: accumulatedContent,
              thinking: accumulatedThinking,
              clean: sawTerminal
            }, usage, ttftAt);
          }
          await reqLogger?.flushStreamLogs?.();
          return;
        }

        if (buffer.trim()) {
          const parsed = parseSSELine(buffer.trim(), targetFormat, { failOnMalformedData: true });
          if (parsed && !parsed.done) {
            markTerminalFromParsed(parsed);
            const translated = translateResponse(targetFormat, sourceFormat, parsed, state);
            markTerminalFromState();
            markTerminalFromTranslated(translated);

            if (translated?._openaiIntermediate) {
              for (const item of translated._openaiIntermediate) {
                const openaiOutput = formatSSE(item, FORMATS.OPENAI);
                reqLogger?.appendOpenAIChunk?.(openaiOutput);
              }
            }

            if (translated?.length > 0) {
              for (const item of translated) {
                const output = formatSSE(item, sourceFormat);
                reqLogger?.appendConvertedChunk?.(output);
                controller.enqueue(sharedEncoder.encode(output));
              }
            }
          } else if (parsed?.done) {
            sawTerminal = true;
          }
        }

        const flushed = translateResponse(targetFormat, sourceFormat, null, state);
        markTerminalFromState();
        markTerminalFromTranslated(flushed);

        if (flushed?._openaiIntermediate) {
          for (const item of flushed._openaiIntermediate) {
            const openaiOutput = formatSSE(item, FORMATS.OPENAI);
            reqLogger?.appendOpenAIChunk?.(openaiOutput);
          }
        }

        if (flushed?.length > 0) {
          for (const item of flushed) {
            const output = formatSSE(item, sourceFormat);
            reqLogger?.appendConvertedChunk?.(output);
            controller.enqueue(sharedEncoder.encode(output));
          }
        }

        maybeEmitDone(controller);

        if (!hasValidUsage(state?.usage) && totalContentLength > 0) {
          state.usage = estimateUsage(body, totalContentLength, sourceFormat);
        }

        if (hasValidUsage(state?.usage) && !onStreamComplete && sawTerminal) {
          logUsage(state.provider || targetFormat, state.usage, model, connectionId, apiKey);
        } else if (!hasValidUsage(state?.usage) && sawTerminal) {
          appendRequestLog({ model, provider, connectionId, tokens: null, status: "200 OK" }).catch(() => { });
        }
        
        if (onStreamComplete) {
          onStreamComplete({
            content: accumulatedContent,
            thinking: accumulatedThinking,
            clean: sawTerminal
          }, state?.usage, ttftAt);
        }
      } catch (error) {
        console.error("Error in flush:", error);
        if (error instanceof MalformedSSEDataError) {
          controller.error(error);
        }
      } finally {
        await reqLogger?.flushStreamLogs?.();
      }
    }
  });
}

export function createSSETransformStreamWithLogger(targetFormat, sourceFormat, provider = null, reqLogger = null, toolNameMap = null, model = null, connectionId = null, body = null, onStreamComplete = null, apiKey = null, onPendingRelease = null) {
  return createSSEStream({
    mode: STREAM_MODE.TRANSLATE,
    targetFormat,
    sourceFormat,
    provider,
    reqLogger,
    toolNameMap,
    model,
    connectionId,
    body,
    onStreamComplete,
    onPendingRelease,
    apiKey
  });
}

export function createPassthroughStreamWithLogger(provider = null, reqLogger = null, model = null, connectionId = null, body = null, onStreamComplete = null, apiKey = null, sourceFormat = null, onPendingRelease = null) {
  return createSSEStream({
    mode: STREAM_MODE.PASSTHROUGH,
    sourceFormat,
    provider,
    reqLogger,
    model,
    connectionId,
    body,
    onStreamComplete,
    onPendingRelease,
    apiKey
  });
}
