import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  authenticateRequest,
} from "../services/auth.js";
import { getSettingsSafe } from "@/lib/localDb";
import { getModelInfo, getComboModels, getBrokenComboError } from "../services/model.js";
import { handleEmbeddingsCore } from "open-sse/handlers/embeddingsCore.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { handleComboChat } from "open-sse/services/combo.js";
import {
  resolveProviderRetryLimits,
  noActiveCredentialsResponse,
  exhaustedAccountsResponse,
} from "../utils/providerCredentialRetry.js";
import { isInvalidJsonObjectBody } from "../utils/jsonBody.js";
import { isRegisteredProviderId } from "../utils/providerRegistry.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";

/**
 * Handle embeddings request for the SSE/Next.js server.
 * Follows the same auth + fallback pattern as handleChat.
 *
 * @param {Request} request
 */
export async function handleEmbeddings(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("EMBEDDINGS", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }
  if (isInvalidJsonObjectBody(body)) {
    log.warn("EMBEDDINGS", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const url = new URL(request.url);
  const modelStr = body.model;

  log.request("POST", `${url.pathname} | ${modelStr}`);

  const auth = await authenticateRequest(request, log);
  if (!auth.ok) return auth.response;
  const { settings } = auth;

  if (!modelStr) {
    log.warn("EMBEDDINGS", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }

  const input = body.input;
  if (input === null || input === undefined || input === "") {
    log.warn("EMBEDDINGS", "Missing input");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: input");
  }
  if (typeof input !== "string" && !Array.isArray(input)) {
    log.warn("EMBEDDINGS", "Invalid input type");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "input must be a string or array of strings");
  }
  if (Array.isArray(input)) {
    if (input.length === 0) {
      log.warn("EMBEDDINGS", "Empty input array");
      return errorResponse(HTTP_STATUS.BAD_REQUEST, "input array must not be empty");
    }
    for (let i = 0; i < input.length; i++) {
      if (typeof input[i] !== "string") {
        log.warn("EMBEDDINGS", `Invalid input[${i}] type`);
        return errorResponse(HTTP_STATUS.BAD_REQUEST, `input[${i}] must be a string`);
      }
    }
  }

  const brokenComboError = await getBrokenComboError(modelStr);
  if (brokenComboError) {
    log.warn("EMBEDDINGS", `Combo resolution failed: ${brokenComboError}`);
    return errorResponse(HTTP_STATUS.BAD_REQUEST, brokenComboError);
  }

  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    const comboStrategies = settings.comboStrategies || {};
    const comboStrategy = comboStrategies[modelStr]?.fallbackStrategy || settings.comboStrategy || "fallback";
    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("EMBEDDINGS", `Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: comboModels,
      handleSingleModel: (b, m) => handleSingleModelEmbeddings(b, m, request.signal),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit,
    });
  }

  return handleSingleModelEmbeddings(body, modelStr, request.signal);
}

async function handleSingleModelEmbeddings(body, modelStr, signal) {
  const modelInfo = await getModelInfo(modelStr);
  if (!modelInfo.provider) {
    const brokenComboError = await getBrokenComboError(modelStr);
    if (brokenComboError) {
      log.warn("EMBEDDINGS", `Combo resolution failed: ${brokenComboError}`);
      return errorResponse(HTTP_STATUS.BAD_REQUEST, brokenComboError);
    }
    const comboModels = await getComboModels(modelStr);
    if (comboModels) {
      const settings = await getSettingsSafe();
      const comboStrategies = settings.comboStrategies || {};
      const comboStrategy = comboStrategies[modelStr]?.fallbackStrategy || settings.comboStrategy || "fallback";
      const comboStickyLimit = settings.comboStickyRoundRobinLimit;
      return handleComboChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m) => handleSingleModelEmbeddings(b, m, signal),
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit,
      });
    }
    log.warn("EMBEDDINGS", "Invalid model format", { model: modelStr });
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      `Failed to resolve model: "${modelStr}". Not a registered alias, combo name, or valid provider/model format.`
    );
  }

  const { provider, model } = modelInfo;

  if (!isRegisteredProviderId(provider)) {
    log.warn("EMBEDDINGS", `Unknown provider: ${provider}`);
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `Unknown provider: ${provider}`);
  }

  if (modelStr !== `${provider}/${model}`) {
    log.info("ROUTING", `${modelStr} → ${provider}/${model}`);
  } else {
    log.info("ROUTING", `Provider: ${provider}, Model: ${model}`);
  }

  const { isNoAuthProvider, maxRetries } = await resolveProviderRetryLimits(provider);
  if (!isNoAuthProvider && maxRetries === 0) {
    log.warn("AUTH", `No active credentials for provider: ${provider}`);
    return noActiveCredentialsResponse(provider);
  }

  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;
  let had5xx = false;
  let retryCount = 0;

  while (true) {
    if (retryCount >= maxRetries) {
      log.warn("EMBEDDINGS", `Max retries (${maxRetries}) exhausted for ${provider}/${model}`);
      return exhaustedAccountsResponse(had5xx, lastStatus, lastError);
    }

    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model);

    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("EMBEDDINGS", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) {
        log.warn("AUTH", `No active credentials for provider: ${provider}`);
        return noActiveCredentialsResponse(provider);
      }
      log.warn("EMBEDDINGS", "No more accounts available", { provider });
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

    const result = await handleEmbeddingsCore({
      body: { ...body, model: `${provider}/${model}` },
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      log,
      signal,
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
      }
    });

    if (result.success) return result.response;

    if (result.status === 499) return result.response;

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
