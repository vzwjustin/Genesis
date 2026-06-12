import { getProviderAlias } from "@/shared/constants/providers";
import { getProviderModels } from "open-sse/config/providerModels.js";
import { getModelAliases, setModelAlias } from "@/models";
import { fetchModelsForConnection } from "./fetchConnectionModels.js";
import { resolveModelAlias } from "./resolveModelAlias.js";

function normalizeModelId(rawId, connection) {
  if (!rawId) return null;
  let modelId = String(rawId).trim();
  if (!modelId) return null;

  const providerAlias = getProviderAlias(connection.provider);
  const providerPrefix = `${connection.provider}/`;
  const aliasPrefix = `${providerAlias}/`;

  if (modelId.startsWith(providerPrefix)) {
    modelId = modelId.slice(providerPrefix.length);
  } else if (modelId.startsWith(aliasPrefix)) {
    modelId = modelId.slice(aliasPrefix.length);
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

    const providerAlias = getProviderAlias(connection.provider);
    const staticIds = new Set(getProviderModels(providerAlias).map((m) => m.id));
    const existingAliases = { ...(await getModelAliases()) };

    let imported = 0;
    for (const model of result.models) {
      const modelId = normalizeModelId(model.id || model.name || model.model, connection);
      if (!modelId || staticIds.has(modelId)) continue;

      const alias = resolveModelAlias(modelId, providerAlias, existingAliases);
      if (!alias) continue;

      const fullModel = `${providerAlias}/${modelId}`;
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
