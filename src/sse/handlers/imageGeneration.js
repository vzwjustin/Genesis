import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  authenticateRequest,
  rollbackStickyUseCount,
} from "../services/auth.js";
import { getSettings, getSettingsSafe } from "@/lib/localDb";
import { getModelInfo, getComboModels, getBrokenComboError } from "../services/model.js";
import { handleImageGenerationCore } from "open-sse/handlers/imageGenerationCore.js";
import { getImageAdapter } from "open-sse/handlers/imageProviders/index.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { handleComboChat } from "open-sse/services/combo.js";
import {
  resolveProviderRetryLimits,
  noActiveCredentialsResponse,
  exhaustedAccountsResponse,
} from "../utils/providerCredentialRetry.js";
import { isInvalidJsonObjectBody } from "../utils/jsonBody.js";
import { isRegisteredProviderId } from "../utils/providerRegistry.js";
import * as log from "../utils/logger.js";

/**
 * Handle image generation request
 * @param {Request} request
 */
export async function handleImageGeneration(request) {
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
  const preferredConnectionId = request.headers.get("x-connection-id") || null;
  const wantsStream = (request.headers.get("accept") || "").includes("text/event-stream");
  const binaryOutput = url.searchParams.get("response_format") === "binary";
  const modelStr = body.model;

  const auth = await authenticateRequest(request, log);
  if (!auth.ok) return auth.response;
  const { apiKey, settings } = auth;

  if (!modelStr) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  if (!body.prompt) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: prompt");

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
    log.info("IMAGE", `Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: comboModels,
      handleSingleModel: (b, m) => handleSingleModelImage(b, m, { wantsStream, binaryOutput, preferredConnectionId, signal: request.signal }),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit,
    });
  }

  return handleSingleModelImage(body, modelStr, { wantsStream, binaryOutput, preferredConnectionId, signal: request.signal });
}

async function handleSingleModelImage(body, modelStr, { wantsStream, binaryOutput, preferredConnectionId, signal } = {}) {
  const modelInfo = await getModelInfo(modelStr);
  if (!modelInfo.provider) {
    const brokenComboError = await getBrokenComboError(modelStr);
    if (brokenComboError) {
      return errorResponse(HTTP_STATUS.BAD_REQUEST, brokenComboError);
    }
    const comboModels = await getComboModels(modelStr);
    if (comboModels) {
      const settings = await getSettingsSafe();
      const comboStrategies = settings.comboStrategies || {};
      const comboStrategy = comboStrategies[modelStr]?.fallbackStrategy || settings.comboStrategy || "fallback";
      const comboStickyLimit = settings.comboStickyRoundRobinLimit;
      log.info("IMAGE", `Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
      return handleComboChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m) => handleSingleModelImage(b, m, { wantsStream, binaryOutput, preferredConnectionId, signal }),
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit,
      });
    }
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      `Failed to resolve model: "${modelStr}". Not a registered alias, combo name, or valid provider/model format.`
    );
  }

  const { provider, model } = modelInfo;

  if (!isRegisteredProviderId(provider)) {
    log.warn("IMAGE", `Unknown provider: ${provider}`);
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `Unknown provider: ${provider}`);
  }

  // noAuth providers — derived from image adapter config
  if (getImageAdapter(provider)?.noAuth) {
    const result = await handleImageGenerationCore({
      body,
      modelInfo: { provider, model },
      credentials: null,
      binaryOutput,
      signal,
    });
    if (result.success) return result.response;
    return errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error || "Image generation failed");
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
      log.warn("IMAGE", `Max retries (${maxRetries}) exhausted for ${provider}/${model}`);
      return exhaustedAccountsResponse(had5xx, lastStatus, lastError);
    }

    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model, { preferredConnectionId });

    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) {
        return noActiveCredentialsResponse(provider);
      }
      return exhaustedAccountsResponse(had5xx, lastStatus, lastError);
    }

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

    retryCount++;

    const result = await handleImageGenerationCore({
      body,
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      streamToClient: wantsStream,
      binaryOutput,
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
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      if (result.status >= 500 && result.status < 600) had5xx = true;
      continue;
    }

    return result.response;
  }
}
