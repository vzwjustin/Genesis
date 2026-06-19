import "open-sse/index.js";

import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  rollbackStickyUseCount,
  authenticateRequest,
} from "../services/auth.js";
import { cacheClaudeHeaders } from "open-sse/utils/claudeHeaderCache.js";
import { getSettingsSafe } from "@/lib/localDb";
import { getModelInfo, getComboModels, getBrokenComboError } from "../services/model.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { errorResponse, unavailableResponse, validationErrorResponse, VALIDATION_ERROR_TYPES, modelNotFoundResponse, noConnectionsResponse } from "open-sse/utils/error.js";
import { buildModelsList } from "@/app/api/v1/models/route.js";
import { handleComboChat, handleFusionChat } from "open-sse/services/combo.js";
import { handleBypassRequest } from "open-sse/utils/bypassHandler.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import { buildProxyOptionsFromCredentials } from "open-sse/utils/proxyFetch.js";
import { AI_PROVIDERS, resolveProviderId } from "@/shared/constants/providers.js";
import {
  resolveProviderRetryLimits,
  noActiveCredentialsResponse,
  exhaustedAccountsResponse,
} from "../utils/providerCredentialRetry.js";
import { isInvalidJsonObjectBody } from "../utils/jsonBody.js";
import { isRegisteredProviderId } from "../utils/providerRegistry.js";
import { logInboundSummary } from "open-sse/utils/requestLogger.js";

/**
 * Derive the inbound wire type from the request endpoint (Req 7.1).
 * `/v1/messages` is the Anthropic_Wire; everything else is OpenAI_Wire.
 */
function inboundWireFromRequest(request) {
  try {
    const pathname = new URL(request.url).pathname;
    return pathname.includes("/v1/messages") ? "anthropic" : "openai";
  } catch {
    return "openai";
  }
}

/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 *
 * Emits exactly one inbound-request summary on completion (success or error)
 * via logInboundSummary (Req 7.1–7.4). The emit is fail-open: logInboundSummary
 * never throws and is gated on ENABLE_REQUEST_LOGS, so logging can never break
 * the request path.
 */
export async function handleChat(request, clientRawRequest = null) {
  // Mutable summary context populated as the request flows through resolution.
  // Single source of truth for the one completion summary emitted below.
  const summary = {
    inboundWire: inboundWireFromRequest(request),
    rawModel: null,
    resolvedModel: null,
    authFailureReason: null,
    unresolvedModel: undefined,
    registeredModels: undefined,
  };
  const response = await handleChatInner(request, clientRawRequest, summary);
  logInboundSummary({
    inboundWire: summary.inboundWire,
    rawModel: summary.rawModel,
    resolvedModel: summary.resolvedModel,
    status: typeof response?.status === "number" ? response.status : null,
    authFailureReason: summary.authFailureReason,
    unresolvedModel: summary.unresolvedModel,
    registeredModels: summary.registeredModels,
  });
  return response;
}

async function handleChatInner(request, clientRawRequest = null, summary = {}) {
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("CHAT", "Invalid JSON body");
    return validationErrorResponse(VALIDATION_ERROR_TYPES.TRANSLATION_INVALID_BODY, "Invalid JSON body");
  }
  if (isInvalidJsonObjectBody(body)) {
    log.warn("CHAT", "Invalid JSON body");
    return validationErrorResponse(VALIDATION_ERROR_TYPES.TRANSLATION_INVALID_BODY, "Invalid JSON body");
  }

  // Build clientRawRequest for logging (if not provided)
  if (!clientRawRequest) {
    const url = new URL(request.url);
    clientRawRequest = {
      endpoint: url.pathname,
      body,
      headers: Object.fromEntries(request.headers.entries()),
      signal: request.signal,
    };
  }

  // Record raw model field for the inbound summary as early as possible so it is
  // present even when auth fails before resolution (Req 7.1/7.3).
  summary.rawModel = typeof body.model === "string" ? body.model : null;

  const auth = await authenticateRequest(request, log);
  if (!auth.ok) {
    // Classify the auth failure reason (Req 7.3) from the request's credential
    // shape — never from the key value. authenticateRequest already redacts;
    // here we only inspect header presence/shape, never the secret itself.
    summary.authFailureReason = classifyAuthFailureReason(request);
    return auth.response;
  }
  const { apiKey, settings } = auth;

  // Log request endpoint and model (after auth)
  const url = new URL(request.url);
  const modelStr = body.model;
  const msgCount = body.messages?.length || body.input?.length || 0;
  const toolCount = body.tools?.length || 0;
  const effort = body.reasoning_effort || body.reasoning?.effort || null;
  log.request("POST", `${url.pathname} | ${modelStr} | ${msgCount} msgs${toolCount ? ` | ${toolCount} tools` : ""}${effort ? ` | effort=${effort}` : ""}`);

  if (!modelStr) {
    log.warn("CHAT", "Missing model");
    return validationErrorResponse(VALIDATION_ERROR_TYPES.MISSING_REQUIRED_FIELD, "Missing required field: model");
  }

  // Bypass naming/warmup requests before combo rotation to avoid wasting rotation slots
  const userAgent = request?.headers?.get("user-agent") || "";
  const bypassResponse = handleBypassRequest(body, modelStr, userAgent, !!settings?.ccFilterNaming);
  if (bypassResponse) return bypassResponse.response || bypassResponse;

  // Check if model is a combo (has multiple models with fallback)
  const brokenComboError = await getBrokenComboError(modelStr);
  if (brokenComboError) {
    log.warn("CHAT", `Combo resolution failed: ${brokenComboError}`);
    return validationErrorResponse(VALIDATION_ERROR_TYPES.VALIDATION_FAILED, brokenComboError);
  }

  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    // Check for combo-specific strategy first, fallback to global
    const comboStrategies = settings.comboStrategies || {};
    const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
    const comboStrategy = comboSpecificStrategy || settings.comboStrategy || "fallback";

    if (comboStrategy === "fusion") {
      log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
      return handleFusionChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m, isPanel) => {
          let cleanRawReq = clientRawRequest;
          if (isPanel && clientRawRequest) {
            const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
            cleanRawReq = { ...clientRawRequest, body: cleanBody };
          }
          return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, summary);
        },
        log,
        comboName: modelStr,
        judgeModel: comboStrategies[modelStr]?.judgeModel,
        tuning: comboStrategies[modelStr]?.fusionTuning,
      });
    }

    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: comboModels,
      handleSingleModel: (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, summary),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit
    });
  }

  // Single model request
  return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, summary);
}

/**
 * List registered model ids built from the same source as GET /v1/models so the
 * "available models" list returned on resolution failure stays consistent with
 * enumeration. Fails open to an empty list — surfacing a 404 without suggestions
 * is preferable to turning a model-resolution error into a 500.
 *
 * buildModelsList currently returns an array of model objects; Task 13.1 will
 * change it to { models, warnings }. Extract ids defensively to tolerate both.
 */
async function listRegisteredModelIds() {
  try {
    const result = await buildModelsList(["llm"]);
    const models = Array.isArray(result) ? result : result?.models;
    if (!Array.isArray(models)) return [];
    return models
      .map((m) => m?.id)
      .filter((id) => typeof id === "string" && id.length > 0);
  } catch (e) {
    log.warn("CHAT", `Could not build available models list: ${e?.message || e}`);
    return [];
  }
}

/**
 * Classify an inbound auth failure into a reason ∈ {missing_header, invalid_key,
 * malformed_header} for the inbound summary (Req 7.3). Inspects only the
 * Authorization header's presence and shape — NEVER the token/key value, which
 * must never reach the log.
 */
function classifyAuthFailureReason(request) {
  try {
    const authHeader = request?.headers?.get?.("authorization");
    if (!authHeader) return "missing_header";
    // Well-formed "Bearer {token}" with a non-empty token → the key itself is
    // invalid; otherwise the header shape is malformed.
    const match = /^Bearer\s+(\S+)/i.exec(authHeader);
    return match ? "invalid_key" : "malformed_header";
  } catch {
    return null;
  }
}

/**
 * Handle single model chat request
 */
async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null, summary = {}) {
  const modelInfo = await getModelInfo(modelStr);

  // Unresolved model string — fail closed with 404 + the registered model ids
  // (Requirement 1.2). Never guess the intended model.
  if (!modelInfo.provider) {
    log.warn("CHAT", `Model resolution failed: "${modelStr}" is not a registered alias, combo, or provider/model format`);
    // Req 7.2 — record the unresolved string + the full registered set for the
    // inbound summary. resolvedModel stays null (resolution failed).
    const registered = await listRegisteredModelIds();
    summary.resolvedModel = null;
    summary.unresolvedModel = modelStr;
    summary.registeredModels = registered;
    return modelNotFoundResponse(modelStr, registered);
  }

  const { provider, model } = modelInfo;

  // Req 7.1 — resolution succeeded: record the resolved Provider_Model_String.
  summary.resolvedModel = `${provider}/${model}`;

  if (!isRegisteredProviderId(provider)) {
    log.warn("CHAT", `Unknown provider: ${provider}`);
    return validationErrorResponse(
      VALIDATION_ERROR_TYPES.VALIDATION_FAILED,
      `Unknown provider: ${provider}`
    );
  }

  // Log resolved routing path for every request (Requirement 2.5)
  log.info("ROUTING", `${modelStr} → ${provider}/${model}`);

  // Try with available accounts (fallback on errors)
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;
  let had5xx = false;

  const { isNoAuthProvider, maxRetries } = await resolveProviderRetryLimits(provider);

  // Resolved provider but zero configured connections — fail closed with 503
  // (Requirement 1.3). Zero connections means zero retries; do not attempt an
  // upstream request.
  if (!isNoAuthProvider && maxRetries === 0) {
    log.warn("AUTH", `No active connections for provider: ${provider}`);
    return noConnectionsResponse(provider);
  }

  const resolvedProvider = AI_PROVIDERS[resolveProviderId(provider)];
  if (resolvedProvider?.noAuth) {
    log.info("AUTH", `\x1b[32m${provider} no-auth mode\x1b[0m`);
    const result = await dispatchChatCore({
      body,
      model,
      provider,
      clientRawRequest,
      request,
      apiKey,
      credentials: null,
      connectionId: null,
    });
    if (result.success) return result.response;
    return result.response;
  }

  let retryCount = 0;

  while (true) {
    // Enforce max retry limit (Requirement 4.7)
    if (retryCount >= maxRetries) {
      log.warn("CHAT", `Max retries (${maxRetries}) exhausted for ${provider}/${model}`);
      return exhaustedAccountsResponse(had5xx, lastStatus, lastError);
    }

    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model);

    // All accounts unavailable
    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("CHAT", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) {
        log.warn("AUTH", `No active credentials for provider: ${provider}`);
        return noActiveCredentialsResponse(provider);
      }
      log.warn("CHAT", "No more accounts available", { provider });
      return exhaustedAccountsResponse(had5xx, lastStatus, lastError);
    }

    // Log account selection
    log.info("AUTH", `\x1b[32mUsing ${provider} account: ${credentials.connectionName}\x1b[0m`);

    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    // Requirement 3.6: If token refresh fails during pre-check, mark connection
    // as unusable and proceed to Account_Fallback for the next available connection.
    if (refreshedCredentials._tokenRefreshFailed) {
      log.warn("AUTH", `Token refresh failed for ${credentials.connectionName}, falling back to next connection`);
      await rollbackStickyUseCount(credentials.connectionId);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = "Token refresh failed";
      lastStatus = 401;
      continue;
    }

    if (clientRawRequest?.headers) {
      const normalizedHeaders = Object.fromEntries(
        Object.entries(clientRawRequest.headers).map(([k, v]) => [k.toLowerCase(), String(v)])
      );
      cacheClaudeHeaders(normalizedHeaders, credentials.connectionId);
      refreshedCredentials._requestHeaders = normalizedHeaders;
    }

    // Ensure real project ID is available for providers that need it (P0 fix: cold miss)
    if ((provider === "antigravity" || provider === "gemini-cli") && !refreshedCredentials.projectId) {
      const pid = await getProjectIdForConnection(
        credentials.connectionId,
        refreshedCredentials.accessToken,
        buildProxyOptionsFromCredentials(refreshedCredentials)
      );
      if (pid) {
        refreshedCredentials.projectId = pid;
        // Persist to DB in background so subsequent requests have it immediately
        updateProviderCredentials(credentials.connectionId, { projectId: pid }).catch(() => { });
      }
    }

    if (provider === "antigravity" && !refreshedCredentials.projectId) {
      log.warn("AUTH", `Antigravity missing projectId for ${credentials.connectionName}, trying next connection`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = "Antigravity requires projectId (Cloud Code Assist fetch failed)";
      lastStatus = 400;
      await rollbackStickyUseCount(credentials.connectionId);
      continue;
    }

    retryCount++;

    const result = await dispatchChatCore({
      body,
      model,
      provider,
      clientRawRequest,
      request,
      apiKey,
      credentials: refreshedCredentials,
      connectionId: credentials.connectionId,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          accessToken: newCreds.accessToken,
          refreshToken: newCreds.refreshToken,
          providerSpecificData: newCreds.providerSpecificData,
          testStatus: "active"
        });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
      },
      onRequestFailed: async () => {
        await rollbackStickyUseCount(credentials.connectionId);
      },
    });

    if (result.success) return result.response;

    if (result.status === 499) {
      return result.response;
    }

    // Mark account unavailable (auto-calculates cooldown with exponential backoff, or precise resetsAtMs)
    const { shouldFallback } = await markAccountUnavailable(
      credentials.connectionId,
      result.status,
      result.error,
      provider,
      model,
      result.resetsAtMs,
      { proxyInternal: result.proxyInternal, errorCode: result.errorCode }
    );

    if (shouldFallback) {
      log.warn("AUTH", `Account ${credentials.connectionName} unavailable (${result.status}), trying fallback`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      if (result.status >= 500 && result.status < 600) had5xx = true;
      continue;
    }

    return result.response;
  }
}

async function dispatchChatCore({
  body,
  model,
  provider,
  clientRawRequest,
  request,
  apiKey,
  credentials,
  connectionId,
  onCredentialsRefreshed,
  onRequestSuccess,
  onRequestFailed,
}) {
  const userAgent = request?.headers?.get("user-agent") || "";
  const chatSettings = await getSettingsSafe();
  const providerThinking = (chatSettings.providerThinking || {})[provider] || null;
  return handleChatCore({
    body: { ...body, model: `${provider}/${model}` },
    modelInfo: { provider, model },
    credentials,
    log,
    clientRawRequest,
    connectionId,
    userAgent,
    apiKey,
    ccFilterNaming: !!chatSettings.ccFilterNaming,
    rtkEnabled: chatSettings.rtkEnabled !== false,
    rtkFilterConfig: chatSettings.rtkFilterConfig || null,
    cavemanEnabled: chatSettings.cavemanEnabled === true,
    cavemanLevel: chatSettings.cavemanLevel || "full",
    headroomEnabled: chatSettings.headroomEnabled === true,
    passthroughCompression: !!chatSettings.passthroughCompression,
    providerThinking,
    sourceFormatOverride: request?.url ? detectFormatByEndpoint(new URL(request.url).pathname, body) : null,
    onCredentialsRefreshed,
    onRequestSuccess,
    onRequestFailed,
  });
}
