import {
  AI_PROVIDERS,
  isAnthropicCompatibleProvider,
  isOpenAICompatibleProvider,
} from "@/shared/constants/providers";

function defaultAliasFromModelId(modelId) {
  const parts = String(modelId).split("/");
  return parts[parts.length - 1];
}

/**
 * Pick a dashboard alias for a provider model id.
 * Mirrors CompatibleModelsSection.resolveAlias behavior.
 */
export function resolveModelAlias(modelId, providerStorageAlias, existingAliases = {}) {
  if (!modelId || !providerStorageAlias) return null;

  const fullModel = `${providerStorageAlias}/${modelId}`;
  if (Object.values(existingAliases).includes(fullModel)) return null;

  const providerInfo = Object.values(AI_PROVIDERS).find((p) => p.alias === providerStorageAlias)
    || AI_PROVIDERS[providerStorageAlias];
  const providerId = providerInfo?.id || providerStorageAlias;
  const useCompatibleRules = providerInfo?.passthroughModels
    || (providerId && isOpenAICompatibleProvider(providerId))
    || (providerId && isAnthropicCompatibleProvider(providerId));

  const baseAlias = defaultAliasFromModelId(modelId);
  if (!useCompatibleRules) {
    if (!existingAliases[modelId]) return modelId;
    return null;
  }

  if (!existingAliases[baseAlias]) return baseAlias;
  const prefixedAlias = `${providerStorageAlias}-${baseAlias}`;
  if (!existingAliases[prefixedAlias]) return prefixedAlias;
  return null;
}
