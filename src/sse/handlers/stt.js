import {
  authenticateRequest,
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
} from "../services/auth.js";
import { getSettingsSafe } from "@/lib/localDb";
import { getModelInfo, getComboModels, getBrokenComboError } from "../services/model.js";
import { handleSttCore } from "open-sse/handlers/sttCore.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { handleComboChat } from "open-sse/services/combo.js";
import {
  resolveProviderRetryLimits,
  noActiveCredentialsResponse,
  exhaustedAccountsResponse,
} from "../utils/providerCredentialRetry.js";
import * as log from "../utils/logger.js";
import { checkAndRefreshToken } from "../services/tokenRefresh.js";

const CREDENTIALED_PROVIDERS = new Set(
  Object.entries(AI_PROVIDERS)
    .filter(([, p]) => p.serviceKinds?.includes("stt") && !p.noAuth && p.sttConfig?.authType !== "none")
    .map(([id]) => id)
);

export async function handleStt(request) {
  let formData;
  try {
    formData = await request.formData();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid multipart form data");
  }

  const modelStr = formData.get("model");
  log.request("POST", `/v1/audio/transcriptions | ${modelStr}`);

  const auth = await authenticateRequest(request, log);
  if (!auth.ok) return auth.response;
  const { settings } = auth;

  if (!modelStr) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  if (!formData.get("file")) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: file");

  const brokenComboError = await getBrokenComboError(modelStr);
  if (brokenComboError) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, brokenComboError);
  }

  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    const comboStrategies = settings.comboStrategies || {};
    const comboStrategy = comboStrategies[modelStr]?.fallbackStrategy || settings.comboStrategy || "fallback";
    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("STT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body: formData,
      models: comboModels,
      handleSingleModel: (fd, m) => handleSingleModelStt(fd, m),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit,
    });
  }

  return handleSingleModelStt(formData, modelStr);
}

async function handleSingleModelStt(formData, modelStr) {
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
      return handleComboChat({
        body: formData,
        models: comboModels,
        handleSingleModel: (fd, m) => handleSingleModelStt(fd, m),
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
  log.info("ROUTING", `Provider: ${provider}, Model: ${model}`);

  if (!CREDENTIALED_PROVIDERS.has(provider)) {
    const result = await handleSttCore({ provider, model, formData });
    if (result.success) return result.response;
    return errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error || "STT failed");
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
      log.warn("STT", `Max retries (${maxRetries}) exhausted for ${provider}/${model}`);
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

    const result = await handleSttCore({ provider, model, formData, credentials: refreshedCredentials });

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
