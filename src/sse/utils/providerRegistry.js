import {
  AI_PROVIDERS,
  resolveProviderId,
  isOpenAICompatibleProvider,
  isAnthropicCompatibleProvider,
  isCustomEmbeddingProvider,
} from "@/shared/constants/providers.js";
import { errorResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";

/** True when provider id is a known registry entry or dynamic compatible-node id. */
export function isRegisteredProviderId(providerId) {
  if (!providerId || typeof providerId !== "string") return false;
  const id = resolveProviderId(providerId);
  if (AI_PROVIDERS[id]) return true;
  if (isOpenAICompatibleProvider(id)) return true;
  if (isAnthropicCompatibleProvider(id)) return true;
  if (isCustomEmbeddingProvider(id)) return true;
  return false;
}

export function unknownProviderErrorResponse(provider) {
  return errorResponse(HTTP_STATUS.BAD_REQUEST, `Unknown provider: ${provider}`);
}
