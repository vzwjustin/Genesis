import { getProviderConnections } from "@/lib/localDb";
import { resolveProviderId, FREE_PROVIDERS } from "@/shared/constants/providers.js";
import { errorResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";

/**
 * Requirement 4.7/4.8: max retries = configured connection count; zero → immediate 404.
 */
export async function resolveProviderRetryLimits(provider) {
  const providerId = resolveProviderId(provider);
  const isNoAuthProvider = !!FREE_PROVIDERS[providerId]?.noAuth;
  const allConnections = await getProviderConnections({ provider: providerId, isActive: true });
  const maxRetries = isNoAuthProvider ? 1 : allConnections.length;
  return { providerId, isNoAuthProvider, maxRetries };
}

export function noActiveCredentialsResponse(provider) {
  return errorResponse(HTTP_STATUS.NOT_FOUND, `No active credentials for provider: ${provider}`);
}

export function exhaustedAccountsResponse(had5xx, lastStatus, lastError) {
  const exhaustedStatus = had5xx ? HTTP_STATUS.SERVICE_UNAVAILABLE : (lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE);
  return errorResponse(exhaustedStatus, lastError || "All accounts unavailable");
}
