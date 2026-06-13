import "open-sse/index.js";

import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  authenticateRequest,
} from "../services/auth.js";
import { cacheClaudeHeaders } from "open-sse/utils/claudeHeaderCache.js";
import { getSettingsSafe } from "@/lib/localDb";
import { getModelInfo, getComboModels, getBrokenComboError } from "../services/model.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { errorResponse, unavailableResponse, validationErrorResponse, VALIDATION_ERROR_TYPES } from "open-sse/utils/error.js";
import { handleComboChat } from "open-sse/services/combo.js";
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

/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 */
export async function handleChat(request, clientRawRequest = null) {
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
  // Log request endpoint and model
  const url = new URL(request.url);
  const modelStr = body.model;

  // Count messages (support both messages[] and input[] formats)
  const msgCount = body.messages?.length || body.input?.length || 0;
  const toolCount = body.tools?.length || 0;
  const effort = body.reasoning_effort || body.reasoning?.effort || null;
  log.request("POST", `${url.pathname} | ${modelStr} | ${msgCount} msgs${toolCount ? ` | ${toolCount} tools` : ""}${effort ? ` | effort=${effort}` : ""}`);

  const auth = await authenticateRequest(request, log);
  if (!auth.ok) return auth.response;
  const { apiKey, settings } = auth;

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
    
    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: comboModels,
      handleSingleModel: (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit
    });
  }

  // Single model request
  return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey);
}

/**
 * Handle single model chat request
 */
async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null) {
  const modelInfo = await getModelInfo(modelStr);

  // If provider is null, this might be a combo name - check and handle
  if (!modelInfo.provider) {
    const brokenComboError = await getBrokenComboError(modelStr);
    if (brokenComboError) {
      log.warn("CHAT", `Combo resolution failed: ${brokenComboError}`);
      return validationErrorResponse(VALIDATION_ERROR_TYPES.VALIDATION_FAILED, brokenComboError);
    }

    const comboModels = await getComboModels(modelStr);
    if (comboModels) {
      const chatSettings = await getSettingsSafe();
      // Check for combo-specific strategy first, fallback to global
      const comboStrategies = chatSettings.comboStrategies || {};
      const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
      const comboStrategy = comboSpecificStrategy || chatSettings.comboStrategy || "fallback";
      
      const comboStickyLimit = chatSettings.comboStickyRoundRobinLimit;
      log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
      return handleComboChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey),
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit
      });
    }
    // All resolution methods exhausted: not a provider/model format, not a registered alias,
    // not a valid combo. Return HTTP 400 per Requirement 2.4 — do NOT silently fall back.
    log.warn("CHAT", `Model resolution failed: "${modelStr}" is not a registered alias, combo, or provider/model format`);
    return validationErrorResponse(
      VALIDATION_ERROR_TYPES.VALIDATION_FAILED,
      `Failed to resolve model: "${modelStr}". Not a registered alias, combo name, or valid provider/model format. Check your model configuration.`
    );
  }

  const { provider, model } = modelInfo;

  // Log resolved routing path for every request (Requirement 2.5)
  log.info("ROUTING", `${modelStr} → ${provider}/${model}`);

  // Try with available accounts (fallback on errors)
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;
  let had5xx = false;

  const { isNoAuthProvider, maxRetries } = await resolveProviderRetryLimits(provider);

  if (!isNoAuthProvider && maxRetries === 0) {
    log.warn("AUTH", `No active credentials for provider: ${provider}`);
    return noActiveCredentialsResponse(provider);
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
    });

    if (result.success) return result.response;

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
  });
}
