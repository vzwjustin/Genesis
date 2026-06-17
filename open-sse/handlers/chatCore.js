import { detectFormat, getTargetFormat } from "../services/provider.js";
import { parseModel } from "../services/model.js";
import { translateRequest } from "../translator/index.js";
import { FORMATS } from "../translator/formats.js";
import { COLORS } from "../utils/stream.js";
import { createStreamController } from "../utils/streamHandler.js";
import { refreshWithRetry, isUnrecoverableRefreshError } from "../services/tokenRefresh.js";
import { createRequestLogger } from "../utils/requestLogger.js";
import { getModelTargetFormat, getModelStrip, getModelUpstreamId, PROVIDER_ID_TO_ALIAS } from "../config/providerModels.js";
import { createErrorResult, parseUpstreamError, formatProviderError, VALIDATION_ERROR_TYPES, PROXY_INTERNAL_ERROR_CODES } from "../utils/error.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import { handleBypassRequest } from "../utils/bypassHandler.js";
import { trackPendingRequest, appendRequestLog, saveRequestDetail } from "@/lib/usageDb.js";
import { getExecutor } from "../executors/index.js";
import { buildRequestDetail, extractRequestConfig } from "./chatCore/requestDetail.js";
import { handleForcedSSEToJson } from "./chatCore/sseToJsonHandler.js";
import { handleNonStreamingResponse } from "./chatCore/nonStreamingHandler.js";
import { handleStreamingResponse, buildOnStreamComplete } from "./chatCore/streamingHandler.js";
import { detectClientTool, shouldUseNativePassthrough, parseStreamIntentHeader } from "../utils/clientDetector.js";
import { stripTrailingAssistantPrefill } from "../translator/helpers/openaiHelper.js";
import { isFusionProvider, resolveFusionPlugins } from "../utils/fusionPlugin.js";
import { dedupeTools } from "../utils/toolDeduper.js";
import { cleanAnthropicToolDefinitions, fixToolUseOrdering, usesAnthropicToolCleaning } from "../translator/helpers/claudeHelper.js";
import { applyCloaking } from "../utils/claudeCloaking.js";
import { deriveSessionId } from "../utils/sessionManager.js";
import { getCachedClaudeHeaders } from "../utils/claudeHeaderCache.js";
import { injectCaveman } from "../rtk/caveman.js";
import { compressMessages, formatRtkLog } from "../rtk/index.js";
import {
  hasAnthropicCacheBreakpoints,
  snapshotCacheProtectedBody,
  verifyCacheProtectedBody,
  restoreBodyFromJsonSnapshot,
  findLastCacheBoundary,
} from "../rtk/cacheBoundary.js";
import { compressWithHeadroom } from "../rtk/headroom.js";
import { saveCompressionStats } from "@/lib/compressionStats.js";
import { buildProxyOptionsFromCredentials } from "../utils/proxyFetch.js";
import { checkCircuitBreaker, recordUpstreamTelemetry, releaseCircuitProbe } from "../utils/upstreamTelemetry.js";

function buildExecCredentials(credentials, { clientHasCacheBreakpoints = false, passthrough = false } = {}) {
  if (!clientHasCacheBreakpoints && !passthrough) return credentials;
  return {
    ...credentials,
    ...(clientHasCacheBreakpoints ? { _preserveClientCache: true } : {}),
    ...(passthrough ? { _passthrough: true } : {}),
  };
}

function isClientAbortError(error, signal) {
  return signal?.aborted || error?.name === "AbortError" || error?.message === "Request aborted";
}

/**
 * Core chat handler - shared between SSE and Worker
 * @param {object} options.body - Request body
 * @param {object} options.modelInfo - { provider, model }
 * @param {object} options.credentials - Provider credentials
 * @param {boolean} options.passthroughCompression - Whether to allow compression in passthrough mode
 * @param {string} options.sourceFormatOverride - Override detected source format (e.g. "openai-responses")
 */
export async function handleChatCore({ body, modelInfo, credentials, log, onCredentialsRefreshed, onRequestSuccess, onRequestFailed, onDisconnect, clientRawRequest, connectionId, userAgent, apiKey, ccFilterNaming, rtkEnabled, rtkFilterConfig, cavemanEnabled, cavemanLevel, headroomEnabled, passthroughCompression, sourceFormatOverride, providerThinking }) {
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
  const clientHeaders = clientRawRequest?.headers || {};
  const requestPathname = (() => {
    const endpoint = clientRawRequest?.endpoint;
    if (!endpoint) return "";
    try {
      return new URL(endpoint, "http://localhost").pathname;
    } catch {
      return String(endpoint).split("?")[0] || "";
    }
  })();
  const clientTool = detectClientTool(clientHeaders, body);
  const passthrough = shouldUseNativePassthrough(clientTool, provider, {
    body,
    headers: Object.fromEntries(
      Object.entries(clientHeaders).map(([k, v]) => [k.toLowerCase(), String(v)])
    ),
    pathname: requestPathname,
  });

  if (
    !passthrough
    && provider === "claude"
    && sourceFormat === FORMATS.OPENAI
    && requestPathname.includes("/v1/chat/completions")
    && typeof body?.model === "string"
    && /^(cc\/|claude[-/])/i.test(body.model)
  ) {
    log?.warn?.(
      "PASSTHROUGH",
      `${body.model} hit /v1/chat/completions (openai wire). cc/claude needs @ai-sdk/anthropic → /v1/messages for passthrough. Reapply OpenCode settings from genesis dashboard.`
    );
  }

  let originalClientBody;
  try {
    originalClientBody = structuredClone(body);
  } catch {
    try {
      originalClientBody = JSON.parse(JSON.stringify(body));
    } catch {
      return createErrorResult(HTTP_STATUS.BAD_REQUEST, "Request body could not be cloned", undefined, { errorType: VALIDATION_ERROR_TYPES.TRANSLATION_INVALID_BODY, errorCode: VALIDATION_ERROR_TYPES.TRANSLATION_INVALID_BODY });
    }
  }

  // reasoning_effort "none" → explicit disabled thinking before translation (Claude rejects bare effort)
  if (!passthrough && body.reasoning_effort === "none" && !body.thinking) {
    const { reasoning_effort: _re, ...rest } = body;
    body = { ...rest, thinking: { type: "disabled" } };
  }

  // Inject provider-level thinking config override (only if client hasn't set)
  // on/off → extended type (body.thinking), none/low/medium/high → effort type (body.reasoning_effort)
  // PASSTHROUGH GUARD: Do NOT inject thinking config in passthrough mode — only model + auth are swapped.
  if (!passthrough && providerThinking?.mode && providerThinking.mode !== "auto") {
    const mode = providerThinking.mode;
    const isThinkingMode = mode === "on" || mode === "off";
    if (isThinkingMode) {
      // Extended thinking toggle — only inject if the client hasn't already configured it.
      // Do NOT fall through to reasoning_effort: "on"/"off" are not valid effort values.
      if (!body.thinking) {
        if (mode === "on") {
          console.log("Injecting provider-level thinking config override: on");
          body = { ...body, thinking: { type: "enabled", budget_tokens: 10000 } };
        } else {
          body = { ...body, thinking: { type: "disabled" } };
        }
      }
    } else if (!body.reasoning_effort) {
      // Effort-based thinking (none/low/medium/high) — only inject if not already set.
      body = { ...body, reasoning_effort: mode };
    }
  }

  // Gemini-family native formats (Antigravity / Gemini / Gemini-CLI) encode stream intent
  // in the endpoint verb (:streamGenerateContent = SSE, :generateContent = single JSON),
  // not in body.stream — the native body has no `stream` field. The MITM layer surfaces
  // that verb as the x-genesis-stream-intent header. When the signal is absent (legacy
  // callers / direct API), default to streaming so existing clients never regress.
  const geminiFamilyFormat = sourceFormat === FORMATS.ANTIGRAVITY || sourceFormat === FORMATS.GEMINI || sourceFormat === FORMATS.GEMINI_CLI;
  const geminiWantsStream = geminiFamilyFormat ? (parseStreamIntentHeader(clientHeaders) ?? true) : false;
  const clientRequestedStreaming = body.stream === true || geminiWantsStream;
  const providerRequiresStreaming = provider === "openai" || provider === "codex" || provider === "commandcode";
  let stream = providerRequiresStreaming ? true : (body.stream !== false);

  // Passthrough preserves the client contract: omitted stream is non-streaming,
  // explicit stream:true streams, and native streaming formats keep their stream.
  // Gemini-family formats also resolve `stream` from the verb here (translated mode
  // included) so a :generateContent client receives assembled JSON, never raw SSE.
  if ((passthrough || geminiFamilyFormat) && !providerRequiresStreaming) stream = clientRequestedStreaming;

  // DeepSeek-TUI: interactive TUI panel sends stream:true and needs SSE.
  // Non-interactive mode (-p flag) sends without stream and can't parse SSE.
  // Only force non-streaming when client didn't explicitly request it.
  if (clientTool === "deepseek-tui" && body.stream !== true) stream = false;

  // Check client Accept header preference for non-streaming requests
  // This fixes AI SDK compatibility where clients send Accept: application/json
  const acceptHeader = clientRawRequest?.headers?.accept || "";
  const clientPrefersJson = acceptHeader.includes("application/json");
  const clientPrefersSSE = acceptHeader.includes("text/event-stream");
  if (!passthrough && clientPrefersJson && !clientPrefersSSE && body.stream !== true) {
    stream = false;
  }

  const reqLogger = await createRequestLogger(sourceFormat, targetFormat, model, { passthrough });
  if (clientRawRequest) reqLogger.logClientRawRequest(clientRawRequest.endpoint, clientRawRequest.body, clientRawRequest.headers);
  reqLogger.logRawRequest(originalClientBody);
  log?.debug?.("FORMAT", `${sourceFormat} → ${targetFormat} | stream=${stream}`);

  // Native passthrough: CLI tool and provider are the same ecosystem
  // Skip all translation/normalization — only model and Bearer are swapped
  // (clientTool and passthrough already detected earlier, before any body mutations)

  let translatedBody;
  let toolNameMap;
  if (passthrough) {
    log?.debug?.("PASSTHROUGH", `${clientTool} → ${provider} | native lossless`);
    try {
      translatedBody = structuredClone(body);
    } catch {
      try {
        translatedBody = JSON.parse(JSON.stringify(body));
      } catch (cloneError) {
        const errMsg = cloneError?.message || "Passthrough body could not be cloned";
        return createErrorResult(HTTP_STATUS.BAD_REQUEST, errMsg, undefined, { errorType: VALIDATION_ERROR_TYPES.TRANSLATION_INVALID_BODY, errorCode: VALIDATION_ERROR_TYPES.TRANSLATION_INVALID_BODY });
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

    // Post-translation validation: ensure translated body is a valid object with content
    if (!translatedBody || typeof translatedBody !== "object") {
      return createErrorResult(HTTP_STATUS.BAD_REQUEST, `Translation produced invalid output for ${targetFormat}`, undefined, { errorType: VALIDATION_ERROR_TYPES.VALIDATION_FAILED, errorCode: VALIDATION_ERROR_TYPES.VALIDATION_FAILED });
    }
  }

  // The translator strips Anthropic cache_control markers when translating across
  // formats involving OpenAI (source or target) — markers cannot be honored or
  // preserved byte-for-byte after translation. Mirror that here or model-id resolution,
  // snapshotting, and compression gating would all misfire on stale markers.
  const cacheStrippedForCrossFormatTranslation =
    !passthrough
    && sourceFormat !== targetFormat
    && (targetFormat === FORMATS.OPENAI || sourceFormat === FORMATS.OPENAI);
  const clientHasCacheBreakpoints =
    !cacheStrippedForCrossFormatTranslation && hasAnthropicCacheBreakpoints(originalClientBody);

  // Pristine client snapshot — before model swap, OAuth metadata, tool cleaning, dedupe, or compression.
  const cacheProtectedSnapshot = clientHasCacheBreakpoints
    ? snapshotCacheProtectedBody(translatedBody)
    : null;

  // Keep the client's upstream model id when they own cache layout — rewriting breaks KV hits.
  // Otherwise resolve to the model's upstream id (e.g. fusion → openrouter/fusion). For every
  // provider whose model id already equals its upstream id, getModelUpstreamId is a no-op.
  if (clientHasCacheBreakpoints && typeof translatedBody.model === "string") {
    const parsed = parseModel(translatedBody.model);
    translatedBody.model = parsed.model || model;
  } else {
    translatedBody.model = getModelUpstreamId(alias, model);
  }

  // OpenRouter Fusion: inject panel/judge plugins unless the client sent its own.
  // Required even in passthrough — clients rarely include the plugins field.
  if (isFusionProvider(provider)) {
    const clientSentPlugins = Array.isArray(body.plugins) && body.plugins.length > 0;
    if (!clientSentPlugins) {
      const plugins = resolveFusionPlugins({
        savedFusion: credentials?.providerSpecificData?.fusion,
        alias,
        model,
      });
      if (plugins) {
        translatedBody.plugins = plugins;
      }
    }
  }

  // Fusion fans out to Anthropic 4.6+ panel members that reject assistant prefill.
  // Allowed in passthrough: upstream rejects trailing assistant turns (compatibility fix).
  if (provider === "fusion" && Array.isArray(translatedBody.messages)) {
    translatedBody.messages = stripTrailingAssistantPrefill(translatedBody.messages);
    if (translatedBody.messages.length === 0) {
      return createErrorResult(
        HTTP_STATUS.BAD_REQUEST,
        "Request has no messages after removing trailing assistant prefill; Fusion requires the conversation to end on a user turn",
        undefined,
        { errorType: VALIDATION_ERROR_TYPES.VALIDATION_FAILED, errorCode: VALIDATION_ERROR_TYPES.VALIDATION_FAILED }
      );
    }
  }

  // OAuth metadata alignment for native Claude CLI passthrough only (translated path uses prepareClaudeRequest).
  // Format-aligned clients (e.g. OpenCode on /v1/messages) own body + HTTP headers — do not inject cloaking.
  if (
    passthrough
    && clientTool === "claude"
    && (provider === "claude" || provider?.startsWith("anthropic-compatible"))
  ) {
    const bearerKey = credentials?.accessToken || credentials?.apiKey;
    if (bearerKey?.includes("sk-ant-oat")) {
      const cached = getCachedClaudeHeaders(connectionId, credentials?._requestHeaders);
      const sessionId = cached?.["x-claude-code-session-id"]
        || (connectionId ? deriveSessionId(connectionId) : null);
      Object.assign(translatedBody, applyCloaking(translatedBody, bearerKey, sessionId));
    }
  }

  const usesAnthropicTools = usesAnthropicToolCleaning(provider, clientHasCacheBreakpoints);

  // Tool cleaning: protected prefix stays byte-identical; uncached tail still gets compatibility fixes.
  if (usesAnthropicTools && Array.isArray(translatedBody.tools)) {
    translatedBody.tools = cleanAnthropicToolDefinitions(translatedBody.tools, provider, {
      preserveClientCache: clientHasCacheBreakpoints,
    });
    if (translatedBody.tools.length === 0 && !clientHasCacheBreakpoints && !passthrough) {
      delete translatedBody.tools;
      delete translatedBody.tool_choice;
    }
  }

  // Passthrough: fix tool_use/tool_result ordering only when tools are present (compatibility fix).
  if (passthrough && usesAnthropicTools && Array.isArray(translatedBody.messages)) {
    const needsToolOrderingFix = translatedBody.messages.some(
      (m) => Array.isArray(m.content)
        && m.content.some((b) => b.type === "tool_use" || b.type === "tool_result")
    );
    if (needsToolOrderingFix) {
      // Client-owned cache: only reorder the uncached tail (same as prepareClaudeRequest).
      if (clientHasCacheBreakpoints) {
        const cacheFloor = findLastCacheBoundary(translatedBody.messages);
        if (cacheFloor >= 0 && cacheFloor < translatedBody.messages.length - 1) {
          const prefix = translatedBody.messages.slice(0, cacheFloor + 1);
          const tail = fixToolUseOrdering(translatedBody.messages.slice(cacheFloor + 1));
          translatedBody.messages = [...prefix, ...tail];
        } else if (cacheFloor < 0) {
          translatedBody.messages = fixToolUseOrdering(translatedBody.messages);
        }
      } else {
        translatedBody.messages = fixToolUseOrdering(translatedBody.messages);
      }
    }
  }

  const assertCacheIntegrity = (stage) => {
    if (!cacheProtectedSnapshot) return null;
    if (verifyCacheProtectedBody(translatedBody, cacheProtectedSnapshot)) return null;
    console.error(`[CACHE] CRITICAL: ${stage} — cache-protected content is no longer byte-identical`);
    return createErrorResult(
      HTTP_STATUS.BAD_GATEWAY,
      "Cache-protected request content was modified",
      undefined,
      { errorCode: PROXY_INTERNAL_ERROR_CODES.CACHE_INTEGRITY_FAILED, proxyInternal: true }
    );
  };

  // Dedupe duplicate built-in tools when equivalent MCP tools are present (Claude clients only).
  // Passthrough (passthru) mode: do NOT alter tool definitions — preserve client's intended request shape.
  if (!passthrough && !clientHasCacheBreakpoints && clientTool === "claude" && Array.isArray(translatedBody.tools)) {
    const { tools: deduped, stripped } = dedupeTools(translatedBody.tools);
    if (stripped.length > 0) {
      translatedBody.tools = deduped;
      log?.debug?.("TOOLDEDUP", `stripped ${stripped.length}: ${stripped.slice(0, 3).join(", ")}${stripped.length > 3 ? "..." : ""}`);
    }
  }

  const preCompressionCacheErr = assertCacheIntegrity("claude pre-compression mutations");
  if (preCompressionCacheErr) return preCompressionCacheErr;

  // Token savers: applied at the final body just before dispatch
  // Covers both passthrough (source shape) and translated (target shape) flows
  const finalFormat = passthrough ? sourceFormat : targetFormat;

  const allowPassthroughCompression = !passthrough || passthroughCompression === true;
  const saversEnabled = rtkEnabled || headroomEnabled || (cavemanEnabled && cavemanLevel);
  // Hard rule: never compress when the client placed cache_control breakpoints.
  let compressionActive = !clientHasCacheBreakpoints
    && allowPassthroughCompression
    && saversEnabled;
  if (clientHasCacheBreakpoints && saversEnabled) {
    log?.debug?.("CACHE", "skipping compression — client owns cache_control layout");
  }

  // Snapshot full body for recovery if compression fails
  let originalBodySnapshot = null;
  if (compressionActive) {
    try {
      originalBodySnapshot = JSON.stringify(translatedBody);
    } catch (snapshotError) {
      console.warn(`[COMPRESSION] Could not snapshot body for restore: ${snapshotError.message}`);
      compressionActive = false;
    }
  }

  const chainStages = [];

  let cacheIntegrityFailed = false;

  const enforceCacheIntegrity = (stage) => {
    if (!cacheProtectedSnapshot) return true;
    if (verifyCacheProtectedBody(translatedBody, cacheProtectedSnapshot)) return true;
    console.error(`[CACHE] CRITICAL: ${stage} mutated cache-protected content — reverting body`);
    cacheIntegrityFailed = true;
    if (originalBodySnapshot) {
      const restored = restoreBodyFromJsonSnapshot(translatedBody, originalBodySnapshot);
      if (!restored) {
        console.error(`[CACHE] CRITICAL: ${stage} — could not restore body after cache violation`);
      }
    }
    return false;
  };

  try {
    // Stage 1 — RTK: sync tool-output compression (cheap, no network)
    if (rtkEnabled && compressionActive) {
      const rtkStats = compressMessages(translatedBody, rtkEnabled, rtkFilterConfig);
      const rtkLine = formatRtkLog(rtkStats);
      if (rtkLine) console.log(rtkLine);
      const rtkScanned = (rtkStats?.bytesBefore || 0) > 0;
      const rtkSaved = rtkScanned && (rtkStats.bytesAfter < rtkStats.bytesBefore || (rtkStats?.hits?.length || 0) > 0);
      if (rtkScanned) {
        const filters = Array.from(new Set((rtkStats?.hits || []).map((hit) => hit.filter))).join(",");
        const saved = (rtkStats?.bytesBefore || 0) - (rtkStats?.bytesAfter || 0);
        if (rtkSaved) chainStages.push(`rtk:${saved}B`);
        saveCompressionStats({
          subsystem: "rtk",
          provider,
          bytesBefore: rtkStats?.bytesBefore || 0,
          bytesAfter: rtkStats?.bytesAfter || 0,
          filterHits: filters ? JSON.stringify(rtkStats.hits.map((h) => h.filter)) : null,
        }).catch(() => {});
      }
      if (!enforceCacheIntegrity("RTK")) {
        cacheIntegrityFailed = true;
      }
    }

    // Stage 2 — Headroom: ML history compression (runs after RTK sees shrunk tool blobs)
    if (headroomEnabled && compressionActive && !cacheIntegrityFailed) {
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
        saveCompressionStats({
          subsystem: "headroom",
          provider,
          bytesBefore: hrStats.before || 0,
          bytesAfter: hrStats.after ?? hrStats.before ?? 0,
        }).catch(() => {});
      } else {
        log?.debug?.("HEADROOM", "skipped (unavailable or empty tail)");
      }
      if (!enforceCacheIntegrity("Headroom")) {
        cacheIntegrityFailed = true;
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
        if (cacheProtectedSnapshot && !verifyCacheProtectedBody(translatedBody, cacheProtectedSnapshot)) {
          return createErrorResult(
            HTTP_STATUS.BAD_GATEWAY,
            "Cache-protected request content was modified after compression restore",
            undefined,
            { errorCode: PROXY_INTERNAL_ERROR_CODES.CACHE_INTEGRITY_FAILED, proxyInternal: true }
          );
        }
        console.warn(`[COMPRESSION] Compression failed, continuing with original content: ${compressionError.message}`);
      } catch (restoreError) {
        console.error(`[COMPRESSION] Failed to restore body after compression error: ${restoreError.message}`);
        return createErrorResult(
          HTTP_STATUS.BAD_GATEWAY,
          "Compression failed and request body could not be restored",
          undefined,
          { errorCode: PROXY_INTERNAL_ERROR_CODES.COMPRESSION_RESTORE_FAILED, proxyInternal: true }
        );
      }
    } else {
      // NOTE: when compressionActive is true, originalBodySnapshot is always
      // set (line ~258) — the only path that leaves it null also sets
      // compressionActive=false. So the `if (originalBodySnapshot)` branch
      // above covers every active-compression failure; no separate
      // compressionActive branch is reachable here.
      console.warn(`[COMPRESSION] Error during compression, continuing: ${compressionError.message}`);
    }
  }

  // Caveman mutates the request body — never run when client cache breakpoints are present
  // or when cache integrity already failed.
  if (cavemanEnabled && cavemanLevel && compressionActive && !cacheIntegrityFailed) {
    try {
      const cavemanInjected = injectCaveman(translatedBody, finalFormat, cavemanLevel, provider);
      if (cavemanInjected) {
        log?.debug?.("CAVEMAN", `${cavemanLevel} | ${finalFormat}`);
        console.log(`[COMPRESSION] chain: caveman:${cavemanLevel}`);
        saveCompressionStats({
          subsystem: "caveman",
          provider,
          bytesBefore: 0,
          bytesAfter: 0,
          level: cavemanLevel,
        }).catch(() => {});
      }
    } catch (cavemanError) {
      console.warn(`[CAVEMAN] Injection failed, continuing without caveman: ${cavemanError.message}`);
    }
  }

  if (cacheIntegrityFailed) {
    const compressionCacheErr = assertCacheIntegrity("compression pipeline");
    if (compressionCacheErr) return compressionCacheErr;
  }

  const preDispatchCacheErr = assertCacheIntegrity("pre-dispatch");
  if (preDispatchCacheErr) return preDispatchCacheErr;

  const executor = getExecutor(provider);
  let pendingReleased = false;
  let pendingHandle = null;
  const releasePending = () => {
    if (pendingReleased) return;
    pendingReleased = true;
    trackPendingRequest(model, provider, connectionId, false, false, pendingHandle);
  };
  pendingHandle = trackPendingRequest(model, provider, connectionId, true);
  appendRequestLog({ model, provider, connectionId, status: "PENDING" }).catch(() => { });

  const msgCount = translatedBody.messages?.length || translatedBody.input?.length || translatedBody.contents?.length || translatedBody.request?.contents?.length || 0;
  log?.debug?.("REQUEST", `${provider.toUpperCase()} | ${model} | ${msgCount} msgs`);

  const finalizeFailedRequest = (message, status = HTTP_STATUS.BAD_GATEWAY) => {
    try {
      trackPendingRequest(model, provider, connectionId, false, true, pendingHandle);
      appendRequestLog({ model, provider, connectionId, status: `FAILED ${status}` }).catch(() => { });
      saveRequestDetail(buildRequestDetail({
        provider, model, connectionId,
        latency: { ttft: 0, total: Date.now() - requestStartTime },
        tokens: { prompt_tokens: 0, completion_tokens: 0 },
        request: extractRequestConfig(body, stream),
        providerRequest: finalBody || translatedBody || null,
        response: { error: message, status, thinking: null },
        status: "error"
      }, { endpoint: clientRawRequest?.endpoint || null })).catch(() => { });
      reqLogger.logError(new Error(message), finalBody || translatedBody);
    } catch {
      // Failure persistence is diagnostic only and must not alter the client response.
    }
  };

  const streamController = createStreamController({
    onDisconnect: (reason) => {
      releasePending();
      if (onDisconnect) onDisconnect(reason);
    },
    onError: () => releasePending(),
    log, provider, model
  });

  const clientSignal = clientRawRequest?.signal;
  let upstreamSignal = streamController.signal;
  if (clientSignal) {
    if (typeof AbortSignal.any === "function") {
      upstreamSignal = AbortSignal.any([clientSignal, streamController.signal]);
    } else if (clientSignal.aborted) {
      streamController.abort();
      streamController.handleDisconnect("client_aborted");
    } else {
      clientSignal.addEventListener("abort", () => {
        // On runtimes without AbortSignal.any, propagate the client abort to
        // the upstream signal immediately (no 500 ms delay from handleDisconnect).
        streamController.abort();
        streamController.handleDisconnect("client_aborted");
      }, { once: true });
    }
  }

  const proxyOptions = buildProxyOptionsFromCredentials(credentials);

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

  const cbCheck = checkCircuitBreaker(provider);
  if (cbCheck.denied) {
    releasePending();
    return createErrorResult(
      HTTP_STATUS.SERVICE_UNAVAILABLE,
      `Provider ${provider} temporarily unavailable (circuit open)`,
      undefined,
      { errorCode: "circuit_open", retryAfterSec: cbCheck.retryAfter }
    );
  }

  try {
    const result = await executor.execute({
      model,
      body: translatedBody,
      stream,
      credentials: buildExecCredentials(credentials, { clientHasCacheBreakpoints, passthrough }),
      signal: upstreamSignal,
      log,
      proxyOptions,
      passthrough,
      cacheProtectedSnapshot,
      sourceFormat,
    });
    providerResponse = result.response;
    providerUrl = result.url;
    providerHeaders = result.headers;
    finalBody = result.transformedBody;
    reqLogger.logTargetRequest(providerUrl, providerHeaders, finalBody);
    recordUpstreamTelemetry(provider, model, requestStartTime, providerResponse);
  } catch (error) {
    const clientAbort = isClientAbortError(error, upstreamSignal);
    if (!clientAbort) {
      recordUpstreamTelemetry(provider, model, requestStartTime, null, { isNetworkError: true });
    } else {
      // Client aborted before any upstream outcome — release the circuit-breaker
      // probe slot so an aborted half-open probe can't wedge the breaker.
      releaseCircuitProbe(provider);
    }
    releasePending();
    reqLogger.logError(error, translatedBody);
    appendRequestLog({ model, provider, connectionId, status: `FAILED ${clientAbort ? 499 : HTTP_STATUS.BAD_GATEWAY}` }).catch(() => { });
    saveRequestDetail(buildRequestDetail({
      provider, model, connectionId,
      latency: { ttft: 0, total: Date.now() - requestStartTime },
      tokens: { prompt_tokens: 0, completion_tokens: 0 },
      request: extractRequestConfig(body, stream),
      providerRequest: translatedBody || null,
      response: { error: error.message || String(error), status: clientAbort ? 499 : 502, thinking: null },
      status: "error"
    })).catch(() => { });

    if (clientAbort) {
      streamController.handleError(error);
      return createErrorResult(499, "Request aborted");
    }
    if (error.code === PROXY_INTERNAL_ERROR_CODES.CACHE_INTEGRITY_FAILED) {
      return createErrorResult(
        HTTP_STATUS.BAD_GATEWAY,
        error.message || "Cache-protected request content was modified",
        undefined,
        { errorCode: PROXY_INTERNAL_ERROR_CODES.CACHE_INTEGRITY_FAILED, proxyInternal: true }
      );
    }
    const errMsg = formatProviderError(error, provider, model, HTTP_STATUS.BAD_GATEWAY);
    console.log(`${COLORS.red}[ERROR] ${errMsg}${COLORS.reset}`);
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, errMsg);
  }

  // Handle 401/403 - try token refresh (skip for noAuth / non-refreshable providers)
  if (!executor.noAuth && (providerResponse.status === HTTP_STATUS.UNAUTHORIZED || providerResponse.status === HTTP_STATUS.FORBIDDEN)) {
    if (executor.supportsTokenRefresh === false) {
      releasePending();
      const { message } = await parseUpstreamError(providerResponse, executor);
      finalizeFailedRequest(message, providerResponse.status);
      return createErrorResult(providerResponse.status, message);
    }
    try {
      const newCredentials = await refreshWithRetry(() => executor.refreshCredentials(credentials, log, proxyOptions), 3, log);
      if (isUnrecoverableRefreshError(newCredentials)) {
        log?.warn?.("TOKEN", `${provider.toUpperCase()} | unrecoverable refresh (${newCredentials.error})`);
        releasePending();
        return createErrorResult(
          HTTP_STATUS.UNAUTHORIZED,
          "Authentication failed: token refresh rejected. Re-authenticate this connection.",
          undefined,
          { errorCode: newCredentials.error, proxyInternal: true }
        );
      }
      if (newCredentials?.accessToken || newCredentials?.copilotToken) {
        log?.info?.("TOKEN", `${provider.toUpperCase()} | refreshed`);
        Object.assign(credentials, newCredentials);
        if (onCredentialsRefreshed) {
          try { await onCredentialsRefreshed(newCredentials); } catch (e) { log?.warn?.("TOKEN", `onCredentialsRefreshed failed: ${e.message}`); }
        }
        // Rebuild exec credentials so the retry carries the refreshed token.
        // When clientHasCacheBreakpoints is true, the spread copy made before refresh
        // does not pick up Object.assign(credentials, newCredentials) above.
        try {
          const retryResult = await executor.execute({
            model,
            body: translatedBody,
            stream,
            credentials: buildExecCredentials(credentials, { clientHasCacheBreakpoints, passthrough }),
            signal: upstreamSignal,
            log,
            proxyOptions,
            passthrough,
            cacheProtectedSnapshot,
            sourceFormat,
          });
          providerResponse = retryResult.response;
          providerUrl = retryResult.url;
          providerHeaders = retryResult.headers;
          finalBody = retryResult.transformedBody;
          recordUpstreamTelemetry(provider, model, requestStartTime, providerResponse);
        } catch (retryError) {
          log?.warn?.("TOKEN", `${provider.toUpperCase()} | retry after refresh failed`);
          releasePending();
          finalizeFailedRequest(`Retry after token refresh failed: ${retryError.message}`, HTTP_STATUS.BAD_GATEWAY);
          return createErrorResult(
            HTTP_STATUS.BAD_GATEWAY,
            `Retry after token refresh failed: ${retryError.message}`
          );
        }
      } else {
        log?.warn?.("TOKEN", `${provider.toUpperCase()} | refresh failed`);
        releasePending();
        const { message } = await parseUpstreamError(providerResponse, executor);
        finalizeFailedRequest(message, providerResponse.status);
        return createErrorResult(providerResponse.status, message);
      }
    } catch (e) {
      log?.warn?.("TOKEN", `${provider.toUpperCase()} | refresh threw: ${e.message}`);
      releasePending();
      const { message } = await parseUpstreamError(providerResponse, executor);
      finalizeFailedRequest(message, providerResponse.status);
      return createErrorResult(providerResponse.status, message);
    }
  }

  // Provider returned error
  if (!providerResponse.ok) {
    releasePending();

    // Relay native upstream error bodies for passthrough and Claude-target routes
    // (OpenCode on /v1/messages, Claude Code, etc.) — avoid OpenAI-shaped rewrites.
    if (passthrough || targetFormat === FORMATS.CLAUDE) {
      let errorBody;
      let errorBodyText;
      let resetsAtMs;
      let upstreamErrorCode;
      const upstreamContentType = providerResponse.headers.get("content-type") || "";
      try {
        errorBodyText = await providerResponse.text();
        try { errorBody = JSON.parse(errorBodyText); } catch { errorBody = null; }
      } catch {
        errorBodyText = "";
        errorBody = null;
      }
      if (executor && typeof executor.parseError === "function") {
        try {
          const parsed = executor.parseError(providerResponse, errorBodyText);
          if (parsed && typeof parsed === "object") {
            resetsAtMs = parsed.resetsAtMs;
            upstreamErrorCode = parsed.code || parsed.errorCode;
          }
        } catch { /* preserve native body path */ }
      }
      if (!upstreamErrorCode && errorBody?.error?.code) {
        upstreamErrorCode = errorBody.error.code;
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
        resetsAtMs,
        errorCode: upstreamErrorCode,
        proxyInternal: false,
        response: new Response(errorBodyText || "", {
          status: providerResponse.status,
          headers: responseHeaders
        })
      };
    }

    const { statusCode, message, resetsAtMs, errorCode: upstreamErrorCode } = await parseUpstreamError(providerResponse, executor);
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
    return createErrorResult(statusCode, errMsg, resetsAtMs, { errorCode: upstreamErrorCode });
  }

  const sharedCtx = { provider, model, body, stream, translatedBody, finalBody, requestStartTime, connectionId, apiKey, clientRawRequest, onRequestSuccess, onRequestFailed, passthrough };
  const appendLog = (extra) => appendRequestLog({ model, provider, connectionId, ...extra }).catch(() => { });
  const trackDone = releasePending;

  // Provider forced streaming but client wants JSON
  if (!clientRequestedStreaming && providerRequiresStreaming) {
    const result = await handleForcedSSEToJson({ ...sharedCtx, providerResponse, sourceFormat, targetFormat, trackDone, appendLog });
    if (result) {
      streamController.handleComplete();
      return result;
    }
    // Provider returned non-SSE JSON — assemble as JSON instead of wrapping in SSE.
    try {
      return await handleNonStreamingResponse({ ...sharedCtx, providerResponse, sourceFormat, targetFormat, reqLogger, toolNameMap, trackDone, appendLog });
    } finally {
      streamController.handleComplete();
    }
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
  const { onStreamComplete, streamDetailId, fireRequestSuccess } = buildOnStreamComplete({ ...sharedCtx, onRequestSuccess, onRequestFailed });
  return handleStreamingResponse({ ...sharedCtx, providerResponse, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap, streamController, onStreamComplete, streamDetailId, fireRequestSuccess, onPendingRelease: releasePending });
}

export function isTokenExpiringSoon(expiresAt, bufferMs = 5 * 60 * 1000) {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() - Date.now() < bufferMs;
}
