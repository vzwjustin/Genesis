import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { v4 as uuidv4 } from "uuid";
import { refreshKiroToken } from "../services/tokenRefresh.js";
import { buildKiroChatUrl, buildKiroFingerprintHeaders } from "../services/kiroHeaders.js";
import { proxyAwareFetch, cancelResponseBody } from "../utils/proxyFetch.js";
import { HTTP_STATUS, RETRY_CONFIG, DEFAULT_RETRY_CONFIG, resolveRetryEntry, FETCH_CONNECT_TIMEOUT_MS } from "../config/runtimeConfig.js";
import { throwOnCacheViolation } from "../rtk/cacheBoundary.js";
import { mergeAbortSignals } from "../utils/abortSignal.js";

/**
 * KiroExecutor - Executor for Kiro AI (AWS CodeWhisperer)
 * Uses AWS CodeWhisperer streaming API with AWS EventStream binary format
 */
export class KiroExecutor extends BaseExecutor {
  constructor() {
    super("kiro", PROVIDERS.kiro);
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    if (credentials) {
      return buildKiroChatUrl(credentials);
    }
    return super.buildUrl(model, stream, urlIndex, credentials);
  }

  buildHeaders(credentials, stream = true) {
    const fingerprint = buildKiroFingerprintHeaders(credentials);
    const headers = {
      ...this.config.headers,
      ...fingerprint,
      "Amz-Sdk-Request": "attempt=1; max=3",
      "Amz-Sdk-Invocation-Id": uuidv4(),
      Accept: this.config.headers?.Accept || "application/vnd.amazon.eventstream",
    };

    if (credentials.accessToken) {
      headers["Authorization"] = `Bearer ${credentials.accessToken}`;
    }

    return headers;
  }

  transformRequest(model, body, stream, credentials) {
    return body;
  }

  /**
   * Custom execute for Kiro - handles AWS EventStream binary response with retry support
   */
  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null, passthrough = false, cacheProtectedSnapshot = null }) {
    const url = this.buildUrl(model, stream, 0, credentials);
    // Passthrough (passthru) mode: skip transformRequest — body is already provider-native.
    // Only model name + auth header are swapped (Requirement 1.2).
    const transformedBody = passthrough ? body : this.transformRequest(model, body, stream, credentials);
    throwOnCacheViolation(transformedBody, cacheProtectedSnapshot, "kiro executor");

    // Merge default retry config with provider-specific config
    const retryConfig = { ...DEFAULT_RETRY_CONFIG, ...this.config.retry };
    let retryAttempts = 0;

    while (true) {
      const headers = this.buildHeaders(credentials, stream);

      // Abort if upstream doesn't return response headers within the connect
      // timeout — mirror base.js so a hung Kiro upstream can't hang forever.
      const connectCtrl = new AbortController();
      const connectTimer = setTimeout(() => connectCtrl.abort(new Error("fetch connect timeout")), FETCH_CONNECT_TIMEOUT_MS);
      const merged = signal
        ? mergeAbortSignals([signal, connectCtrl.signal])
        : { signal: connectCtrl.signal, cleanup: () => {} };

      let response;
      try {
        response = await proxyAwareFetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(transformedBody),
          signal: merged.signal
        }, proxyOptions);
      } catch (error) {
        if (signal?.aborted) throw error;
        const isConnectTimeout = connectCtrl.signal.aborted && error.name === "AbortError";
        if (error.name === "AbortError" && !isConnectTimeout) throw error;

        const { attempts: maxNetworkRetries, delayMs: networkDelayMs } =
          resolveRetryEntry(retryConfig[HTTP_STATUS.BAD_GATEWAY]);
        if (retryAttempts < maxNetworkRetries) {
          retryAttempts++;
          log?.debug?.("RETRY", `network error retry ${retryAttempts}/${maxNetworkRetries} after ${networkDelayMs / 1000}s`);
          await new Promise(resolve => setTimeout(resolve, networkDelayMs));
          continue;
        }
        throw error;
      } finally {
        clearTimeout(connectTimer);
        merged.cleanup?.();
      }

      // Check if should retry based on status code
      const { attempts: maxRetries, delayMs } = resolveRetryEntry(retryConfig[response.status]);
      if (!response.ok && maxRetries > 0 && retryAttempts < maxRetries) {
        retryAttempts++;
        log?.debug?.("RETRY", `${response.status} retry ${retryAttempts}/${maxRetries} after ${delayMs / 1000}s`);
        // Drain abandoned EventStream body so the socket is freed before retry.
        await cancelResponseBody(response);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        continue;
      }

      if (!response.ok) {
        return { response, url, headers, transformedBody };
      }

      // Passthrough: preserve native AWS EventStream bytes (no OpenAI SSE conversion).
      if (passthrough) {
        return { response, url, headers, transformedBody };
      }

      // For non-streaming clients, collect the full EventStream and assemble a JSON response.
      if (stream === false) {
        const jsonResponse = await this.assembleEventStreamToJSON(response, model);
        return { response: jsonResponse, url, headers, transformedBody };
      }

      // Success - transform and return
      // For Kiro, we need to transform the binary EventStream to SSE
      // Create a TransformStream to convert binary to SSE text
      const transformedResponse = this.transformEventStreamToSSE(response, model);
      return { response: transformedResponse, url, headers, transformedBody };
    }
  }

  /**
   * Transform AWS EventStream binary response to SSE text stream
   * Using TransformStream instead of ReadableStream.pull() to avoid Workers timeout
   */
  transformEventStreamToSSE(response, model) {
    let buffer = new Uint8Array(0);
    let chunkIndex = 0;
    const responseId = `chatcmpl-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    const state = {
      endDetected: false,
      finishEmitted: false,
      hasToolCalls: false,
      hasReasoningContent: false,
      reasoningChunkCount: 0,
      toolCallIndex: 0,
      seenToolIds: new Map()
    };

    const transformStream = new TransformStream({
      async transform(chunk, controller) {
        // Append to buffer
        const newBuffer = new Uint8Array(buffer.length + chunk.length);
        newBuffer.set(buffer);
        newBuffer.set(chunk, buffer.length);
        buffer = newBuffer;

        // Parse events from buffer
        let iterations = 0;
        const maxIterations = 1000;
        while (buffer.length >= 16 && iterations < maxIterations) {
          iterations++;
          const view = new DataView(buffer.buffer, buffer.byteOffset);
          const totalLength = view.getUint32(0, false);

          if (totalLength < 16 || totalLength > buffer.length || buffer.length < totalLength) break;

          const eventData = buffer.slice(0, totalLength);
          buffer = buffer.slice(totalLength);

          const event = parseEventFrame(eventData);
          if (!event) continue;

          const eventType = event.headers[":event-type"] || "";
          
          // Track total content length for token estimation
          if (!state.totalContentLength) state.totalContentLength = 0;
          if (!state.contextUsagePercentage) state.contextUsagePercentage = 0;

          // Handle assistantResponseEvent
          if (eventType === "assistantResponseEvent" && event.payload?.content) {
            const content = event.payload.content;
            state.totalContentLength += content.length;
            
            const chunk = {
              id: responseId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{
                index: 0,
                delta: chunkIndex === 0
                  ? { role: "assistant", content }
                  : { content },
                finish_reason: null
              }]
            };
            chunkIndex++;
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
          }

          // Handle reasoningContentEvent (Kiro thinking / reasoning)
          // Kiro returns reasoning as a separate event when the request system
          // prompt contains <thinking_mode>enabled</thinking_mode>. Surface it
          // as OpenAI delta.reasoning_content so downstream translators can map
          // it back to Claude thinking blocks / Anthropic reasoning, etc.
          if (eventType === "reasoningContentEvent") {
            const reasoning = event.payload?.reasoningContentEvent || event.payload || {};
            const reasoningText = (typeof reasoning === "string")
              ? reasoning
              : (reasoning.text || reasoning.content || "");
            if (reasoningText) {
              state.hasReasoningContent = true;
              state.totalContentLength += reasoningText.length;

              const reasoningDelta = state.reasoningChunkCount === 0 && chunkIndex === 0
                ? { role: "assistant", reasoning_content: reasoningText }
                : { reasoning_content: reasoningText };

              const chunk = {
                id: responseId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [{
                  index: 0,
                  delta: reasoningDelta,
                  finish_reason: null
                }]
              };
              chunkIndex++;
              state.reasoningChunkCount++;
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
            }
          }

          // Handle codeEvent
          if (eventType === "codeEvent" && event.payload?.content) {
            const chunk = {
              id: responseId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{
                index: 0,
                delta: { content: event.payload.content },
                finish_reason: null
              }]
            };
            chunkIndex++;
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
          }

          // Handle toolUseEvent
          if (eventType === "toolUseEvent" && event.payload) {
            state.hasToolCalls = true;
            const toolUse = event.payload;
            const toolUses = Array.isArray(toolUse) ? toolUse : [toolUse];

            for (const singleToolUse of toolUses) {
              const toolCallId = singleToolUse.toolUseId || `call_${Date.now()}`;
              const toolName = singleToolUse.name || "";
              const toolInput = singleToolUse.input;

              let toolIndex;
              const isNewTool = !state.seenToolIds.has(toolCallId);

              if (isNewTool) {
                toolIndex = state.toolCallIndex++;
                state.seenToolIds.set(toolCallId, toolIndex);

                const startChunk = {
                  id: responseId,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [{
                    index: 0,
                    delta: {
                      ...(chunkIndex === 0 ? { role: "assistant" } : {}),
                      tool_calls: [{
                        index: toolIndex,
                        id: toolCallId,
                        type: "function",
                        function: {
                          name: toolName,
                          arguments: ""
                        }
                      }]
                    },
                    finish_reason: null
                  }]
                };
                chunkIndex++;
                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(startChunk)}\n\n`));
              } else {
                toolIndex = state.seenToolIds.get(toolCallId);
              }

              if (toolInput !== undefined) {
                let argumentsStr;

                if (typeof toolInput === 'string') {
                  argumentsStr = toolInput;
                } else if (typeof toolInput === 'object') {
                  argumentsStr = JSON.stringify(toolInput);
                } else {
                  continue;
                }

                const argsChunk = {
                  id: responseId,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [{
                    index: 0,
                    delta: {
                      tool_calls: [{
                        index: toolIndex,
                        function: {
                          arguments: argumentsStr
                        }
                      }]
                    },
                    finish_reason: null
                  }]
                };
                chunkIndex++;
                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(argsChunk)}\n\n`));
              }
            }
          }

          // Handle messageStopEvent — note: metering/context events may arrive AFTER this.
          // Set endDetected so the metering handler knows to emit the final chunk once both
          // meteringEvent and contextUsageEvent have arrived. Do NOT emit the finish chunk here
          // because doing so would set finishEmitted=true and suppress the usage-bearing chunk.
          if (eventType === "messageStopEvent") {
            state.endDetected = true;
          }

          // Handle contextUsageEvent to extract contextUsagePercentage (for token estimation fallback)
          if (eventType === "contextUsageEvent" && event.payload?.contextUsagePercentage) {
            state.contextUsagePercentage = event.payload.contextUsagePercentage;
          }

          // Handle metricsEvent for token usage — terminal finish waits on messageStop + metrics.
          if (eventType === "metricsEvent") {
            state.hasMetricsEvent = true;
            const metrics = event.payload?.metricsEvent || event.payload;
            if (metrics && typeof metrics === "object") {
              const inputTokens = metrics.inputTokens || 0;
              const outputTokens = metrics.outputTokens || 0;

              if (inputTokens > 0 || outputTokens > 0) {
                state.usage = {
                  prompt_tokens: inputTokens,
                  completion_tokens: outputTokens,
                  total_tokens: inputTokens + outputTokens
                };
              }
            }
          }

          // Emit final chunk once messageStopEvent and metricsEvent have both arrived.
          if (state.endDetected && state.hasMetricsEvent && !state.finishEmitted) {
            state.finishEmitted = true;
            
            // Estimate tokens if not available from events
            if (!state.usage) {
              // Estimate output tokens from content length
              const estimatedOutputTokens = state.totalContentLength > 0 
                ? Math.max(1, Math.floor(state.totalContentLength / 4))
                : 0;
              
              // Estimate input tokens from contextUsagePercentage
              // Kiro models typically have 200k context window
              const estimatedInputTokens = state.contextUsagePercentage > 0
                ? Math.floor(state.contextUsagePercentage * 200000 / 100)
                : 0;
              
              state.usage = {
                prompt_tokens: estimatedInputTokens,
                completion_tokens: estimatedOutputTokens,
                total_tokens: estimatedInputTokens + estimatedOutputTokens
              };
            }
            
            const finishChunk = {
              id: responseId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{
                index: 0,
                delta: {},
                finish_reason: state.hasToolCalls ? "tool_calls" : "stop"
              }]
            };
            
            // Include usage in final chunk if available
            if (state.usage) {
              finishChunk.usage = state.usage;
            }
            
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(finishChunk)}\n\n`));
          }
        }

        if (iterations >= maxIterations) {
          console.warn("[Kiro] Max iterations reached in event parsing");
        }
      },

      flush(controller) {
        // Truncated upstream — unblock streaming clients without fabricating a successful finish.
        if (!state.endDetected) {
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          return;
        }

        if (!state.finishEmitted) {
          state.finishEmitted = true;
          const finishChunk = {
            id: responseId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{
              index: 0,
              delta: {},
              finish_reason: state.hasToolCalls ? "tool_calls" : "stop"
            }]
          };
          if (state.usage) {
            finishChunk.usage = state.usage;
          }
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(finishChunk)}\n\n`));
        }

        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      }
    });

    // Pipe response body through transform stream
    if (!response.body) {
      return new Response("data: [DONE]\n\n", { status: response.status, headers: { "Content-Type": "text/event-stream" } });
    }
    const transformedStream = response.body.pipeThrough(transformStream);

    return new Response(transformedStream, {
      status: response.status,
      statusText: response.statusText,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      }
    });
  }

  /**
   * Collect the full AWS EventStream binary response and assemble an OpenAI-compatible
   * non-streaming JSON completion object.  Used when the client did not request streaming.
   */
  async assembleEventStreamToJSON(response, model) {
    const responseId = `chatcmpl-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);

    if (!response.body) {
      return new Response(JSON.stringify({
        id: responseId, object: "chat.completion", created, model,
        choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      }), { status: response.status, headers: { "Content-Type": "application/json" } });
    }

    // Collect the full binary stream
    const chunks = [];
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const totalLength = chunks.reduce((n, c) => n + c.length, 0);
    let buffer = new Uint8Array(totalLength);
    let offset = 0;
    for (const c of chunks) { buffer.set(c, offset); offset += c.length; }

    // Parse all EventStream frames
    let totalContent = "";
    let reasoningContent = "";
    const toolCalls = [];
    const seenToolIds = new Map();
    let toolCallIndex = 0;
    let usage = null;
    let contextUsagePercentage = 0;
    let totalContentLength = 0;

    let pos = 0;
    let sawMessageStop = false;
    while (buffer.length - pos >= 16) {
      const view = new DataView(buffer.buffer, buffer.byteOffset + pos);
      const totalLen = view.getUint32(0, false);
      if (totalLen < 16 || pos + totalLen > buffer.length) break;

      const eventData = buffer.slice(pos, pos + totalLen);
      pos += totalLen;
      const event = parseEventFrame(eventData);
      if (!event) continue;

      const eventType = event.headers[":event-type"] || "";

      if (eventType === "reasoningContentEvent") {
        const reasoning = event.payload?.reasoningContentEvent || event.payload || {};
        const reasoningText = (typeof reasoning === "string")
          ? reasoning
          : (reasoning.text || reasoning.content || "");
        if (reasoningText) {
          reasoningContent += reasoningText;
          totalContentLength += reasoningText.length;
        }
      }

      if (eventType === "assistantResponseEvent" && event.payload?.content) {
        totalContent += event.payload.content;
        totalContentLength += event.payload.content.length;
      }

      if (eventType === "codeEvent" && event.payload?.content) {
        totalContent += event.payload.content;
        totalContentLength += event.payload.content.length;
      }

      if (eventType === "toolUseEvent" && event.payload) {
        const toolUses = Array.isArray(event.payload) ? event.payload : [event.payload];
        for (const tu of toolUses) {
          const toolCallId = tu.toolUseId || `call_${Date.now()}`;
          const toolName = tu.name || "";
          const toolInput = tu.input;
          if (!seenToolIds.has(toolCallId)) {
            seenToolIds.set(toolCallId, toolCallIndex++);
            let args = "{}";
            if (toolInput !== undefined) {
              args = typeof toolInput === "string" ? toolInput : JSON.stringify(toolInput);
            }
            toolCalls.push({ id: toolCallId, type: "function", function: { name: toolName, arguments: args } });
          } else if (toolInput !== undefined) {
            const idx = seenToolIds.get(toolCallId);
            const existing = toolCalls[idx];
            if (existing?.function) {
              const argsStr = typeof toolInput === "string" ? toolInput : JSON.stringify(toolInput);
              existing.function.arguments = (existing.function.arguments || "") + argsStr;
            }
          }
        }
      }

      if (eventType === "contextUsageEvent" && event.payload?.contextUsagePercentage) {
        contextUsagePercentage = event.payload.contextUsagePercentage;
      }

      if (eventType === "metricsEvent") {
        const metrics = event.payload?.metricsEvent || event.payload;
        if (metrics && typeof metrics === "object") {
          const inputTokens = metrics.inputTokens || 0;
          const outputTokens = metrics.outputTokens || 0;
          if (inputTokens > 0 || outputTokens > 0) {
            usage = { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens };
          }
        }
      }

      if (eventType === "messageStopEvent") {
        sawMessageStop = true;
      }
    }

    const truncated = pos < buffer.length;
    if (truncated || !sawMessageStop) {
      const message = truncated
        ? "Truncated Kiro EventStream response"
        : "Incomplete Kiro EventStream response (missing messageStopEvent)";
      return new Response(JSON.stringify({
        error: { message, type: "server_error", code: "sse_assembly_failed" }
      }), { status: 502, headers: { "Content-Type": "application/json" } });
    }

    if (!usage) {
      const estimatedOutput = totalContentLength > 0 ? Math.max(1, Math.floor(totalContentLength / 4)) : 0;
      const estimatedInput = contextUsagePercentage > 0 ? Math.floor(contextUsagePercentage * 200000 / 100) : 0;
      usage = { prompt_tokens: estimatedInput, completion_tokens: estimatedOutput, total_tokens: estimatedInput + estimatedOutput };
    }

    const message = { role: "assistant", content: totalContent || null };
    if (reasoningContent) message.reasoning_content = reasoningContent;
    if (toolCalls.length > 0) message.tool_calls = toolCalls;

    const completion = {
      id: responseId,
      object: "chat.completion",
      created,
      model,
      choices: [{
        index: 0,
        message,
        finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop"
      }],
      usage
    };

    return new Response(JSON.stringify(completion), {
      status: response.status,
      headers: { "Content-Type": "application/json" }
    });
  }

  async refreshCredentials(credentials, log, proxyOptions = null) {
    if (!credentials.refreshToken) return null;

    try {
      // Use centralized refreshKiroToken function (handles both AWS SSO OIDC and Social Auth)
      const result = await refreshKiroToken(
        credentials.refreshToken,
        credentials.providerSpecificData,
        log,
        proxyOptions
      );

      return result;
    } catch (error) {
      log?.error?.("TOKEN", `Kiro refresh error: ${error.message}`);
      return null;
    }
  }
}

/**
 * Parse AWS EventStream frame
 */
function parseEventFrame(data) {
  try {
    const view = new DataView(data.buffer, data.byteOffset);
    const headersLength = view.getUint32(4, false);

    // Parse headers
    const headers = {};
    let offset = 12; // After prelude
    const headerEnd = 12 + headersLength;

    while (offset < headerEnd && offset < data.length) {
      const nameLen = data[offset];
      offset++;
      if (offset + nameLen > data.length) break;

      const name = new TextDecoder().decode(data.slice(offset, offset + nameLen));
      offset += nameLen;

      const headerType = data[offset];
      offset++;

      if (headerType === 7) { // String type
        const valueLen = (data[offset] << 8) | data[offset + 1];
        offset += 2;
        if (offset + valueLen > data.length) break;

        const value = new TextDecoder().decode(data.slice(offset, offset + valueLen));
        offset += valueLen;
        headers[name] = value;
      } else {
        break;
      }
    }

    // Parse payload
    const payloadStart = 12 + headersLength;
    const payloadEnd = data.length - 4; // Exclude message CRC

    let payload = null;
    if (payloadEnd > payloadStart) {
      const payloadStr = new TextDecoder().decode(data.slice(payloadStart, payloadEnd));

      // Skip empty or whitespace-only payloads
      if (!payloadStr || !payloadStr.trim()) {
        return { headers, payload: null };
      }

      try {
        payload = JSON.parse(payloadStr);
      } catch (parseError) {
        // Log parse error for debugging
        console.warn(`[Kiro] Failed to parse payload: ${parseError.message} | payload: ${payloadStr.substring(0, 100)}`);
        payload = { raw: payloadStr };
      }
    }

    return { headers, payload };
  } catch {
    return null;
  }
}

export default KiroExecutor;
