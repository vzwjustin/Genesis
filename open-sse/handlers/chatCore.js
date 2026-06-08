import { detectFormat, getTargetFormat } from "../services/provider.js";
import { translateRequest } from "../translator/index.js";
import { FORMATS } from "../translator/formats.js";
import { COLORS } from "../utils/stream.js";
import { createStreamController } from "../utils/streamHandler.js";
import { refreshWithRetry } from "../services/tokenRefresh.js";
import { createRequestLogger } from "../utils/requestLogger.js";
import { getModelTargetFormat, getModelStrip, PROVIDER_ID_TO_ALIAS } from "../config/providerModels.js";
import { createErrorResult, parseUpstreamError, formatProviderError, VALIDATION_ERROR_TYPES } from "../utils/error.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import { handleBypassRequest } from "../utils/bypassHandler.js";
import { trackPendingRequest, appendRequestLog, saveRequestDetail } from "@/lib/usageDb.js";
import { getExecutor } from "../executors/index.js";
import { buildRequestDetail, extractRequestConfig } from "./chatCore/requestDetail.js";
import { handleForcedSSEToJson } from "./chatCore/sseToJsonHandler.js";
import { handleNonStreamingResponse } from "./chatCore/nonStreamingHandler.js";
import { handleStreamingResponse, buildOnStreamComplete } from "./chatCore/streamingHandler.js";
import { detectClientTool, isNativePassthrough } from "../utils/clientDetector.js";
import { dedupeTools } from "../utils/toolDeduper.js";
import { cleanAnthropicToolDefinitions } from "../translator/helpers/claudeHelper.js";
import { injectCaveman } from "../rtk/caveman.js";
import { compressMessages, formatRtkLog } from "../rtk/index.js";
import { compressWithHeadroom } from "../rtk/headroom.js";
import { recordCompressionStats, saveCompressionStats } from "@/lib/compressionStats.js";

/**
 * Core chat handler - shared between SSE and Worker
 * @param {object} options.body - Request body
 * @param {object} options.modelInfo - { provider, model }
 * @param {object} options.credentials - Provider credentials
 * @param {boolean} options.passthroughCompression - Whether to allow compression in passthrough mode
 * @param {string} options.sourceFormatOverride - Override detected source format (e.g. "openai-responses")
 */
export async function handleChatCore({ body, modelInfo, credentials, log, onCredentialsRefreshed, onRequestSuccess, onDisconnect, clientRawRequest, connectionId, userAgent, apiKey, ccFilterNaming, rtkEnabled, rtkFilterConfig, cavemanEnabled, cavemanLevel, headroomEnabled, passthroughCompression, sourceFormatOverride, providerThinking }) {
  const { provider, model } = modelInfo;
  const requestStartTime = Date.now();

  // Pre-dispatch schema validation: body must contain recognizable content
  if (!body || typeof body !== "object") {
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, "Request body must be a JSON object", undefined, { errorType: VALIDATION_ERROR_TYPES.TRANSLATION_INVALID_BODY, errorCode: VALIDATION_ERROR_TYPES.TRANSLATION_INVALID_BODY });
  }

  const sourceFormat = sourceFormatOverride || detectFormat(body, clientRawRequest?.headers);

  // Pre-dispatch validation: source format must be a recognized format
  const VALID_FORMATS = new Set(Object.values(FORMATS));
  if (!sourceFormat || !VALID_FORMATS.has(sourceFormat)) {
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, `Unsupported or unrecognized request format: ${sourceFormat || "unknown"}`, undefined, { errorType: VALIDATION_ERROR_TYPES.UNSUPPORTED_REQUEST, errorCode: VALIDATION_ERROR_TYPES.UNSUPPORTED_REQUEST });
  }

  const hasMessages = body.messages && Array.isArray(body.messages);
  const hasInput = body.input && (Array.isArray(body.input) || typeof body.input === "string");
  const hasContents = body.contents && Array.isArray(body.contents);
  const hasRequest = body.request?.contents && Array.isArray(body.request.contents);
  if (!hasMessages && !hasInput && !hasContents && !hasRequest) {
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, "Request body missing required field: messages, input, or contents", undefined, { errorType: VALIDATION_ERROR_TYPES.MISSING_REQUIRED_FIELD, errorCode: VALIDATION_ERROR_TYPES.MISSING_REQUIRED_FIELD });
  }

  // Check for bypass patterns (warmup, skip, cc naming)
  const bypassResponse = handleBypassRequest(body, model, userAgent, ccFilterNaming);
  if (bypassResponse) return bypassResponse;

  const alias = PROVIDER_ID_TO_ALIAS[provider] || provider;
  const modelTargetFormat = getModelTargetFormat(alias, model);
  const targetFormat = modelTargetFormat || getTargetFormat(provider);
  if (!targetFormat) {
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, `Unsupported provider target format for ${provider}/${model}`, undefined, { errorType: VALIDATION_ERROR_TYPES.UNSUPPORTED_REQUEST, errorCode: VALIDATION_ERROR_TYPES.UNSUPPORTED_REQUEST });
  }
  const stripList = getModelStrip(alias, model);

  // Early passthrough detection: needed before any body mutations to enforce
  // "passthrough means passthrough — only model + auth are swapped" (Requirement 1.2)
  const clientTool = detectClientTool(clientRawRequest?.headers || {}, body);
  const passthrough = isNativePassthrough(clientTool, provider);

  // Inject provider-level thinking config override (only if client hasn't set)
  // on/off → extended type (body.thinking), none/low/medium/high → effort type (body.reasoning_effort)
  // PASSTHROUGH GUARD: Do NOT inject thinking config in passthrough mode — only model + auth are swapped.
  if (!passthrough && providerThinking?.mode && providerThinking.mode !== "auto") {
    const mode = providerThinking.mode;
    if (mode === "on" && !body.thinking) {
      console.log("Injecting provider-level thinking config override: on");
      body = { ...body, thinking: { type: "enabled", budget_tokens: 10000 } };
    } else if (mode === "off" && !body.thinking) {
      body = { ...body, thinking: { type: "disabled" } };
    } else if (!body.reasoning_effort) {
      body = { ...body, reasoning_effort: mode };
    }
  }

  const clientRequestedStreaming = body.stream === true || sourceFormat === FORMATS.ANTIGRAVITY || sourceFormat === FORMATS.GEMINI || sourceFormat === FORMATS.GEMINI_CLI;
  const providerRequiresStreaming = provider === "openai" || provider === "codex" || provider === "commandcode";
  let stream = providerRequiresStreaming ? true : (body.stream !== false);

  // DeepSeek-TUI: interactive TUI panel sends stream:true and needs SSE.
  // Non-interactive mode (-p flag) sends without stream and can't parse SSE.
  // Only force non-streaming when client didn't explicitly request it.
  if (clientTool === "deepseek-tui" && body.stream !== true) stream = false;

  // Check client Accept header preference for non-streaming requests
  // This fixes AI SDK compatibility where clients send Accept: application/json
  const acceptHeader = clientRawRequest?.headers?.accept || "";
  const clientPrefersJson = acceptHeader.includes("application/json");
  const clientPrefersSSE = acceptHeader.includes("text/event-stream");
  if (clientPrefersJson && !clientPrefersSSE && body.stream !== true) {
    stream = false;
  }

  const reqLogger = await createRequestLogger(sourceFormat, targetFormat, model, { passthrough });
  if (clientRawRequest) reqLogger.logClientRawRequest(clientRawRequest.endpoint, clientRawRequest.body, clientRawRequest.headers);
  reqLogger.logRawRequest(body);
  log?.debug?.("FORMAT", `${sourceFormat} → ${targetFormat} | stream=${stream}`);

  // Native passthrough: CLI tool and provider are the same ecosystem
  // Skip all translation/normalization — only model and Bearer are swapped
  // (clientTool and passthrough already detected earlier, before any body mutations)

  let translatedBody;
  let toolNameMap;
  if (passthrough) {
    log?.debug?.("PASSTHROUGH", `${clientTool} → ${provider} | native lossless`);
    translatedBody = { ...body, model };
    // Anthropic compatibility: strip provider prefixes from built-in tool model fields.
    // Passthrough preserves request shape except for this known upstream rejection fix.
    if ((provider === "claude" || provider?.startsWith("anthropic-compatible")) && Array.isArray(translatedBody.tools)) {
      translatedBody.tools = cleanAnthropicToolDefinitions(translatedBody.tools, provider);
      if (translatedBody.tools.length === 0) {
        delete translatedBody.tools;
        delete translatedBody.tool_choice;
      }
    }
  } else {
    try {
      translatedBody = translateRequest(sourceFormat, targetFormat, model, body, stream, credentials, provider, reqLogger, stripList, connectionId, clientTool);
    } catch (translationError) {
      const errMsg = translationError?.message || "Translation threw an unexpected error";
      return createErrorResult(HTTP_STATUS.BAD_REQUEST, `Failed to translate request from ${sourceFormat} to ${targetFormat}: ${errMsg}`, undefined, { errorType: VALIDATION_ERROR_TYPES.TRANSLATION_INVALID_BODY, errorCode: VALIDATION_ERROR_TYPES.TRANSLATION_INVALID_BODY });
    }
    if (!translatedBody) {
      return createErrorResult(HTTP_STATUS.BAD_REQUEST, `Failed to translate request from ${sourceFormat} to ${targetFormat}`, undefined, { errorType: VALIDATION_ERROR_TYPES.TRANSLATION_INVALID_BODY, errorCode: VALIDATION_ERROR_TYPES.TRANSLATION_INVALID_BODY });
    }
    toolNameMap = translatedBody._toolNameMap;
    delete translatedBody._toolNameMap;
    translatedBody.model = model;

    // Post-translation validation: ensure translated body is a valid object with content
    if (!translatedBody || typeof translatedBody !== "object") {
      trackPendingRequest(model, provider, connectionId, false, true);
      return createErrorResult(HTTP_STATUS.BAD_REQUEST, `Translation produced invalid output for ${targetFormat}`, undefined, { errorType: VALIDATION_ERROR_TYPES.VALIDATION_FAILED, errorCode: VALIDATION_ERROR_TYPES.VALIDATION_FAILED });
    }
  }

  // Dedupe duplicate built-in tools when equivalent MCP tools are present (Claude clients only).
  // Passthrough (passthru) mode: do NOT alter tool definitions — preserve client's intended request shape.
  if (!passthrough && clientTool === "claude" && Array.isArray(translatedBody.tools)) {
    const { tools: deduped, stripped } = dedupeTools(translatedBody.tools);
    if (stripped.length > 0) {
      translatedBody.tools = deduped;
      log?.debug?.("TOOLDEDUP", `stripped ${stripped.length}: ${stripped.slice(0, 3).join(", ")}${stripped.length > 3 ? "..." : ""}`);
    }
  }

  // Token savers: applied at the final body just before dispatch
  // Covers both passthrough (source shape) and translated (target shape) flows
  const finalFormat = passthrough ? sourceFormat : targetFormat;

  // Passthrough compression guard: do NOT compress unless passthrough compression
  // is explicitly enabled. This preserves provider-native message arrays in passthrough
  // mode per AGENTS.md and Requirements 1.2, 7.3.
  const compressionAllowed = !passthrough || passthroughCompression === true;

  // Snapshot original body for recovery if compression fails
  let originalBodySnapshot = null;
  if (compressionAllowed) {
    try {
      originalBodySnapshot = JSON.stringify(translatedBody);
    } catch (snapshotError) {
      console.warn(`[COMPRESSION] Could not snapshot body for restore: ${snapshotError.message}`);
    }
  }

  const chainStages = [];

  try {
    // Stage 1 — RTK: sync tool-output compression (cheap, no network)
    if (compressionAllowed && rtkEnabled) {
      const rtkStats = compressMessages(translatedBody, rtkEnabled, rtkFilterConfig);
      const rtkLine = formatRtkLog(rtkStats);
      if (rtkLine) console.log(rtkLine);
      const rtkScanned = (rtkStats?.bytesBefore || 0) > 0;
      const rtkSaved = rtkScanned && (rtkStats.bytesAfter < rtkStats.bytesBefore || (rtkStats?.hits?.length || 0) > 0);
      if (rtkScanned) {
        const filters = Array.from(new Set((rtkStats?.hits || []).map((hit) => hit.filter))).join(",");
        const saved = (rtkStats?.bytesBefore || 0) - (rtkStats?.bytesAfter || 0);
        if (rtkSaved) chainStages.push(`rtk:${saved}B`);
        recordCompressionStats("rtk", {
          bytesBefore: rtkStats?.bytesBefore || 0,
          bytesAfter: rtkStats?.bytesAfter || 0,
          hits: rtkStats?.hits?.length || 0,
          detail: filters || (rtkSaved ? "compressed" : "scanned, no savings"),
        }).catch(() => {});
        if (rtkSaved) saveCompressionStats({
          subsystem: "rtk",
          provider,
          bytesBefore: rtkStats?.bytesBefore || 0,
          bytesAfter: rtkStats?.bytesAfter || 0,
          filterHits: filters ? JSON.stringify(rtkStats.hits.map((h) => h.filter)) : null,
        }).catch(() => {});
      }
    }

    // Stage 2 — Headroom: ML history compression (runs after RTK sees shrunk tool blobs)
    if (compressionAllowed && headroomEnabled) {
      const hrStats = await compressWithHeadroom(translatedBody, model);
      if (hrStats && (hrStats.before || 0) > 0) {
        const saved = Math.max(0, hrStats.saved || 0);
        if (saved > 0) {
          const pct = Math.round((saved / hrStats.before) * 100);
          console.log(`[HEADROOM] saved ${saved}B / ${hrStats.before}B (${pct}%)`);
          chainStages.push(`headroom:${saved}B`);
        } else {
          log?.debug?.("HEADROOM", "ran but no savings");
        }
        recordCompressionStats("headroom", {
          bytesBefore: hrStats.before || 0,
          bytesAfter: hrStats.after ?? hrStats.before ?? 0,
          hits: saved > 0 ? 1 : 0,
          detail: saved > 0 ? model : `${model}: no savings`,
        }).catch(() => {});
        saveCompressionStats({
          subsystem: "headroom",
          provider,
          bytesBefore: hrStats.before || 0,
          bytesAfter: hrStats.after ?? hrStats.before ?? 0,
        }).catch(() => {});
      } else {
        log?.debug?.("HEADROOM", "skipped (unavailable or empty tail)");
      }
    }

    // Stage 3 — Caveman: output-style system prompt injection (always last)
    if (compressionAllowed && cavemanEnabled && cavemanLevel) {
      const cavemanInjected = injectCaveman(translatedBody, finalFormat, cavemanLevel);
      if (cavemanInjected) {
        log?.debug?.("CAVEMAN", `${cavemanLevel} | ${finalFormat}`);
        chainStages.push(`caveman:${cavemanLevel}`);
        recordCompressionStats("caveman", {
          hits: 1,
          detail: `level=${cavemanLevel}`,
        }).catch(() => {});
        saveCompressionStats({
          subsystem: "caveman",
          provider,
          bytesBefore: 0,
          bytesAfter: 0,
          level: cavemanLevel,
        }).catch(() => {});
      }
    }

    if (chainStages.length > 0) {
      console.log(`[COMPRESSION] chain: ${chainStages.join(" → ")}`);
    }
  } catch (compressionError) {
    // Compression failure must never send partially compressed content (Req 7.11)
    if (originalBodySnapshot) {
      try {
        const restored = JSON.parse(originalBodySnapshot);
        for (const key of Object.keys(translatedBody)) {
          if (!(key in restored)) delete translatedBody[key];
        }
        Object.assign(translatedBody, restored);
      } catch (restoreError) {
        console.error(`[COMPRESSION] Failed to restore body after compression error: ${restoreError.message}`);
        trackPendingRequest(model, provider, connectionId, false, true);
        return createErrorResult(
          HTTP_STATUS.BAD_REQUEST,
          "Request compression failed and could not be restored",
          undefined,
          { errorType: VALIDATION_ERROR_TYPES.VALIDATION_FAILED, errorCode: VALIDATION_ERROR_TYPES.VALIDATION_FAILED }
        );
      }
      console.warn(`[COMPRESSION] Compression failed, continuing with original content: ${compressionError.message}`);
    } else {
      console.warn(`[COMPRESSION] Error during compression, continuing: ${compressionError.message}`);
    }
  }

  const executor = getExecutor(provider);
  trackPendingRequest(model, provider, connectionId, true);
  appendRequestLog({ model, provider, connectionId, status: "PENDING" }).catch(() => { });

  const msgCount = translatedBody.messages?.length || translatedBody.input?.length || translatedBody.contents?.length || translatedBody.request?.contents?.length || 0;
  log?.debug?.("REQUEST", `${provider.toUpperCase()} | ${model} | ${msgCount} msgs`);

  const streamController = createStreamController({
    onDisconnect: (reason) => {
      trackPendingRequest(model, provider, connectionId, false);
      if (onDisconnect) onDisconnect(reason);
    },
    onError: () => trackPendingRequest(model, provider, connectionId, false),
    log, provider, model
  });

  const proxyOptions = {
    connectionProxyEnabled: credentials?.providerSpecificData?.connectionProxyEnabled === true,
    connectionProxyUrl: credentials?.providerSpecificData?.connectionProxyUrl || "",
    connectionNoProxy: credentials?.providerSpecificData?.connectionNoProxy || "",
    vercelRelayUrl: credentials?.providerSpecificData?.vercelRelayUrl || "",
  };

  if (proxyOptions.vercelRelayUrl) {
    const connectionName = credentials?.connectionName || credentials?.connectionId || "unknown";
    const poolId = credentials?.providerSpecificData?.connectionProxyPoolId || "none";
    log?.info?.("PROXY", `${provider.toUpperCase()} | ${model} | conn=${connectionName} | pool=${poolId} | vercel-relay=${proxyOptions.vercelRelayUrl}`);
  } else if (proxyOptions.connectionProxyEnabled && proxyOptions.connectionProxyUrl) {
    let maskedProxyUrl = proxyOptions.connectionProxyUrl;
    try {
      const parsed = new URL(proxyOptions.connectionProxyUrl);
      const host = parsed.hostname || "";
      const port = parsed.port ? `:${parsed.port}` : "";
      const protocol = parsed.protocol || "http:";
      maskedProxyUrl = `${protocol}//${host}${port}`;
    } catch {
      // Keep raw if URL parsing fails
    }

    const poolId = credentials?.providerSpecificData?.connectionProxyPoolId || "none";
    const connectionName = credentials?.connectionName || credentials?.connectionId || "unknown";
    log?.info?.("PROXY", `${provider.toUpperCase()} | ${model} | conn=${connectionName} | pool=${poolId} | url=${maskedProxyUrl}`);
  }

  if (proxyOptions.connectionProxyEnabled && proxyOptions.connectionNoProxy) {
    const connectionName = credentials?.connectionName || credentials?.connectionId || "unknown";
    log?.debug?.("PROXY", `${provider.toUpperCase()} | ${model} | conn=${connectionName} | no_proxy=${proxyOptions.connectionNoProxy}`);
  }

  // Execute request
  let providerResponse, providerUrl, providerHeaders, finalBody;
  try {
    const result = await executor.execute({ model, body: translatedBody, stream, credentials, signal: streamController.signal, log, proxyOptions, passthrough });
    providerResponse = result.response;
    providerUrl = result.url;
    providerHeaders = result.headers;
    finalBody = result.transformedBody;
    reqLogger.logTargetRequest(providerUrl, providerHeaders, finalBody);
  } catch (error) {
    trackPendingRequest(model, provider, connectionId, false, true);
    appendRequestLog({ model, provider, connectionId, status: `FAILED ${error.name === "AbortError" ? 499 : HTTP_STATUS.BAD_GATEWAY}` }).catch(() => { });
    saveRequestDetail(buildRequestDetail({
      provider, model, connectionId,
      latency: { ttft: 0, total: Date.now() - requestStartTime },
      tokens: { prompt_tokens: 0, completion_tokens: 0 },
      request: extractRequestConfig(body, stream),
      providerRequest: translatedBody || null,
      response: { error: error.message || String(error), status: error.name === "AbortError" ? 499 : 502, thinking: null },
      status: "error"
    })).catch(() => { });

    if (error.name === "AbortError") {
      streamController.handleError(error);
      return createErrorResult(499, "Request aborted");
    }
    const errMsg = formatProviderError(error, provider, model, HTTP_STATUS.BAD_GATEWAY);
    console.log(`${COLORS.red}[ERROR] ${errMsg}${COLORS.reset}`);
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, errMsg);
  }

  // Handle 401/403 - try token refresh (skip for noAuth providers)
  if (!executor.noAuth && (providerResponse.status === HTTP_STATUS.UNAUTHORIZED || providerResponse.status === HTTP_STATUS.FORBIDDEN)) {
    try {
      const newCredentials = await refreshWithRetry(() => executor.refreshCredentials(credentials, log, proxyOptions), 3, log);
      if (newCredentials?.accessToken || newCredentials?.copilotToken) {
        log?.info?.("TOKEN", `${provider.toUpperCase()} | refreshed`);
        Object.assign(credentials, newCredentials);
        if (onCredentialsRefreshed) {
          try { await onCredentialsRefreshed(newCredentials); } catch (e) { log?.warn?.("TOKEN", `onCredentialsRefreshed failed: ${e.message}`); }
        }
        try {
          const retryResult = await executor.execute({ model, body: translatedBody, stream, credentials, signal: streamController.signal, log, proxyOptions, passthrough });
          if (retryResult.response.ok) { providerResponse = retryResult.response; providerUrl = retryResult.url; providerHeaders = retryResult.headers; }
        } catch { log?.warn?.("TOKEN", `${provider.toUpperCase()} | retry after refresh failed`); }
      } else {
        log?.warn?.("TOKEN", `${provider.toUpperCase()} | refresh failed`);
      }
    } catch (e) {
      log?.warn?.("TOKEN", `${provider.toUpperCase()} | refresh threw: ${e.message}`);
    }
  }

  // Provider returned error
  if (!providerResponse.ok) {
    trackPendingRequest(model, provider, connectionId, false, true);

    // PASSTHROUGH GUARD: In passthrough mode, preserve the upstream error response shape.
    // Do NOT reformat into a generic proxy error — relay the provider's native error body.
    if (passthrough) {
      let errorBody;
      let errorBodyText;
      const upstreamContentType = providerResponse.headers.get("content-type") || "";
      try {
        errorBodyText = await providerResponse.text();
        try { errorBody = JSON.parse(errorBodyText); } catch { errorBody = null; }
      } catch {
        errorBodyText = "";
        errorBody = null;
      }
      appendRequestLog({ model, provider, connectionId, status: `FAILED ${providerResponse.status}` }).catch(() => { });
      saveRequestDetail(buildRequestDetail({
        provider, model, connectionId,
        latency: { ttft: 0, total: Date.now() - requestStartTime },
        tokens: { prompt_tokens: 0, completion_tokens: 0 },
        request: extractRequestConfig(body, stream),
        providerRequest: finalBody || translatedBody || null,
        response: { error: errorBodyText || `Upstream error: ${providerResponse.status}`, status: providerResponse.status, thinking: null },
        status: "error"
      })).catch(() => { });
      const errMsg = formatProviderError(new Error(errorBodyText || `Upstream error: ${providerResponse.status}`), provider, model, providerResponse.status);
      console.log(`${COLORS.red}[ERROR] ${errMsg}${COLORS.reset}`);
      reqLogger.logError(new Error(errorBodyText || "upstream error"), finalBody || translatedBody);

      // Return the provider's native error body as-is
      const responseHeaders = { "Access-Control-Allow-Origin": "*" };
      if (upstreamContentType) responseHeaders["Content-Type"] = upstreamContentType;
      else responseHeaders["Content-Type"] = "application/json";
      return {
        success: false,
        status: providerResponse.status,
        error: errorBodyText || `Upstream error: ${providerResponse.status}`,
        response: new Response(errorBodyText || "", {
          status: providerResponse.status,
          headers: responseHeaders
        })
      };
    }

    const { statusCode, message, resetsAtMs } = await parseUpstreamError(providerResponse, executor);
    appendRequestLog({ model, provider, connectionId, status: `FAILED ${statusCode}` }).catch(() => { });
    saveRequestDetail(buildRequestDetail({
      provider, model, connectionId,
      latency: { ttft: 0, total: Date.now() - requestStartTime },
      tokens: { prompt_tokens: 0, completion_tokens: 0 },
      request: extractRequestConfig(body, stream),
      providerRequest: finalBody || translatedBody || null,
      response: { error: message, status: statusCode, thinking: null },
      status: "error"
    })).catch(() => { });

    const errMsg = formatProviderError(new Error(message), provider, model, statusCode);
    console.log(`${COLORS.red}[ERROR] ${errMsg}${COLORS.reset}`);
    reqLogger.logError(new Error(message), finalBody || translatedBody);
    return createErrorResult(statusCode, errMsg, resetsAtMs);
  }

  const sharedCtx = { provider, model, body, stream, translatedBody, finalBody, requestStartTime, connectionId, apiKey, clientRawRequest, onRequestSuccess, passthrough };
  const appendLog = (extra) => appendRequestLog({ model, provider, connectionId, ...extra }).catch(() => { });
  const trackDone = () => trackPendingRequest(model, provider, connectionId, false);

  // Provider forced streaming but client wants JSON
  if (!clientRequestedStreaming && providerRequiresStreaming) {
    const result = await handleForcedSSEToJson({ ...sharedCtx, providerResponse, sourceFormat, trackDone, appendLog });
    if (result) {
      streamController.handleComplete();
      return result;
    }
    // Provider returned non-SSE; fall through to streaming with controller still connected
  }

  // True non-streaming response
  if (!stream) {
    try {
      return await handleNonStreamingResponse({ ...sharedCtx, providerResponse, sourceFormat, targetFormat, reqLogger, toolNameMap, trackDone, appendLog });
    } finally {
      streamController.handleComplete();
    }
  }

  // Streaming response
  // Destructure streamDetailId so both the initial placeholder save and the
  // onStreamComplete update reference the same DB record.
  const { onStreamComplete, streamDetailId } = buildOnStreamComplete({ ...sharedCtx });
  return handleStreamingResponse({ ...sharedCtx, providerResponse, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap, streamController, onStreamComplete, streamDetailId });
}

export function isTokenExpiringSoon(expiresAt, bufferMs = 5 * 60 * 1000) {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() - Date.now() < bufferMs;
}
