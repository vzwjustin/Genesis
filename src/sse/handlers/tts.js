import {
  authenticateRequest,
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
} from "../services/auth.js";
import { getModelInfo, getComboModels, getBrokenComboError } from "../services/model.js";
import { handleTtsCore } from "open-sse/handlers/ttsCore.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { handleComboChat } from "open-sse/services/combo.js";
import {
  resolveProviderRetryLimits,
  noActiveCredentialsResponse,
  exhaustedAccountsResponse,
} from "../utils/providerCredentialRetry.js";
import { isInvalidJsonObjectBody } from "../utils/jsonBody.js";
import { isRegisteredProviderId } from "../utils/providerRegistry.js";
import * as log from "../utils/logger.js";
import { checkAndRefreshToken } from "../services/tokenRefresh.js";

// Derived from providers.js: any TTS provider not noAuth requires stored credentials
const CREDENTIALED_PROVIDERS = new Set(
  Object.entries(AI_PROVIDERS)
    .filter(([, p]) => p.serviceKinds?.includes("tts") && !p.noAuth && p.ttsConfig?.authType !== "none")
    .map(([id]) => id)
);

export async function handleTts(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }
  if (isInvalidJsonObjectBody(body)) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const url = new URL(request.url);
  const modelStr = body.model;
  const responseFormat = url.searchParams.get("response_format") || "mp3";
  const language = body.language || "";

  const auth = await authenticateRequest(request, log);
  if (!auth.ok) return auth.response;
  const { settings } = auth;

  log.request("POST", `${url.pathname} | ${modelStr} | format=${responseFormat}${language ? ` | lang=${language}` : ""}`);

  if (!modelStr) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  if (body.input === null || body.input === undefined || body.input === "") {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: input");
  }
  if (typeof body.input !== "string") {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "input must be a string");
  }

  // Combo expansion: model may be a combo name → run fallback/round-robin across models
  const brokenComboError = await getBrokenComboError(modelStr);
  if (brokenComboError) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, brokenComboError);
  }

  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    const comboStrategies = settings.comboStrategies || {};
    const comboStrategy = comboStrategies[modelStr]?.fallbackStrategy || settings.comboStrategy || "fallback";
    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("TTS", `Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: comboModels,
      handleSingleModel: (b, m) => handleSingleModelTts(b, m, responseFormat, language, request.signal),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit,
    });
  }

  return handleSingleModelTts(body, modelStr, responseFormat, language, request.signal);
}

async function handleSingleModelTts(body, modelStr, responseFormat, language, signal) {
  const modelInfo = await getModelInfo(modelStr);
  if (!modelInfo.provider) {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      `Failed to resolve model: "${modelStr}". Not a registered alias, combo name, or valid provider/model format.`
    );
  }

  const { provider, model } = modelInfo;

  if (!isRegisteredProviderId(provider)) {
    log.warn("TTS", `Unknown provider: ${provider}`);
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `Unknown provider: ${provider}`);
  }

  log.info("ROUTING", `Provider: ${provider}, Voice: ${model}`);

  // noAuth providers — no credential needed
  if (!CREDENTIALED_PROVIDERS.has(provider)) {
    const result = await handleTtsCore({ provider, model, input: body.input, responseFormat, language, signal });
    if (result.success) return result.response;
    return errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error || "TTS failed");
  }

  const { isNoAuthProvider, maxRetries } = await resolveProviderRetryLimits(provider);
  if (!isNoAuthProvider && maxRetries === 0) {
    return noActiveCredentialsResponse(provider);
  }

  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;
  let had5xx = false;
  let retryCount = 0;

  while (true) {
    if (retryCount >= maxRetries) {
      log.warn("TTS", `Max retries (${maxRetries}) exhausted for ${provider}/${model}`);
      return exhaustedAccountsResponse(had5xx, lastStatus, lastError);
    }

    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model);

    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const msg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        return unavailableResponse(status, `[${provider}/${model}] ${msg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) return noActiveCredentialsResponse(provider);
      return exhaustedAccountsResponse(had5xx, lastStatus, lastError);
    }

    log.info("AUTH", `\x1b[32mUsing ${provider} account: ${credentials.connectionName}\x1b[0m`);

    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    if (refreshedCredentials._tokenRefreshFailed) {
      log.warn("AUTH", `Token refresh failed for ${credentials.connectionName}, falling back to next connection`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = "Token refresh failed";
      lastStatus = 401;
      continue;
    }

    retryCount++;

    const result = await handleTtsCore({
      provider,
      model,
      input: body.input,
      credentials: refreshedCredentials,
      responseFormat,
      language,
      signal,
    });

    if (result.success) {
      await clearAccountError(credentials.connectionId, credentials, model);
      return result.response;
    }

    const { shouldFallback } = await markAccountUnavailable(
      credentials.connectionId,
      result.status,
      result.error,
      provider,
      model,
      null,
      { proxyInternal: result.proxyInternal, errorCode: result.errorCode }
    );
    if (shouldFallback) {
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      if (result.status >= 500 && result.status < 600) had5xx = true;
      continue;
    }
    return result.response || errorResponse(result.status, result.error);
  }
}
