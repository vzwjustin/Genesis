import {
  getProviderAlias,
  isAnthropicCompatibleProvider,
  isOpenAICompatibleProvider,
} from "@/shared/constants/providers";
import { getProviderModels } from "open-sse/config/providerModels.js";
import { getModelAliases, getProviderNodeById, setModelAlias } from "@/models";
import { fetchModelsForConnection } from "./fetchConnectionModels.js";
import { resolveModelAlias } from "./resolveModelAlias.js";

function getProviderStorageAlias(providerId) {
  const isCompatible = isOpenAICompatibleProvider(providerId)
    || isAnthropicCompatibleProvider(providerId);
  return isCompatible ? providerId : getProviderAlias(providerId);
}

async function getProviderDisplayAlias(connection) {
  const providerId = connection.provider;
  const isCompatible = isOpenAICompatibleProvider(providerId)
    || isAnthropicCompatibleProvider(providerId);
  if (isCompatible) {
    return connection.providerSpecificData?.prefix
      || (await getProviderNodeById(providerId))?.prefix
      || providerId;
  }
  return getProviderAlias(providerId);
}

function normalizeModelId(rawId, connection, displayPrefix = null) {
  if (!rawId) return null;
  let modelId = String(rawId).trim();
  if (!modelId) return null;

  const providerAlias = getProviderAlias(connection.provider);
  const providerPrefix = `${connection.provider}/`;
  const aliasPrefix = `${providerAlias}/`;
  const nodePrefix = displayPrefix || connection.providerSpecificData?.prefix;
  const nodeDisplayPrefix = nodePrefix ? `${nodePrefix}/` : null;

  if (modelId.startsWith(providerPrefix)) {
    modelId = modelId.slice(providerPrefix.length);
  } else if (modelId.startsWith(aliasPrefix)) {
    modelId = modelId.slice(aliasPrefix.length);
  } else if (nodeDisplayPrefix && modelId.startsWith(nodeDisplayPrefix)) {
    modelId = modelId.slice(nodeDisplayPrefix.length);
  }

  return modelId;
}

/**
 * Fetch upstream /models for a connection and register aliases for models
 * not already in the static catalog. Fail-open — never throws to callers.
 */
export async function autoImportProviderModels(connection) {
  if (!connection?.id) return { imported: 0, skipped: true };

  try {
    const result = await fetchModelsForConnection(connection);
    if (result.error) {
      const authFailure = result.status === 401 || result.status === 403;
      return {
        imported: 0,
        total: 0,
        warning: result.warning || result.error || null,
        authFailure,
      };
    }
    if (!result.models?.length) {
      return {
        imported: 0,
        total: 0,
        warning: result.warning || "No models returned from upstream",
        upstreamFailure: true,
      };
    }

    const providerStorageAlias = getProviderStorageAlias(connection.provider);
    const providerDisplayAlias = await getProviderDisplayAlias(connection);
    const staticIds = new Set(getProviderModels(providerStorageAlias).map((m) => m.id));
    const existingAliases = { ...(await getModelAliases()) };

    let imported = 0;
    for (const model of result.models) {
      const modelId = normalizeModelId(
        model.id || model.name || model.model,
        connection,
        providerDisplayAlias,
      );
      if (!modelId || staticIds.has(modelId)) continue;

      const alias = resolveModelAlias(
        modelId,
        providerStorageAlias,
        existingAliases,
        providerDisplayAlias,
      );
      if (!alias) continue;

      const fullModel = `${providerStorageAlias}/${modelId}`;
      await setModelAlias(alias, fullModel);
      existingAliases[alias] = fullModel;
      imported += 1;
    }

    return { imported, total: result.models.length, warning: result.warning || null };
  } catch (error) {
    console.error("[autoImportProviderModels]", error?.message || error);
    return { imported: 0, error: error?.message || String(error) };
  }
}
