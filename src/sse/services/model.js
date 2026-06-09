// Re-export from open-sse with localDb integration
import { getModelAliases, getComboByName, getProviderNodes } from "@/lib/localDb";
import { parseModel as parseModelCore, resolveModelAliasFromMap } from "open-sse/services/model.js";

// Local provider alias overrides (HMR-friendly, applied on top of open-sse map)
const LOCAL_PROVIDER_ALIASES = {
  xmtp: "xiaomi-tokenplan",
  "xiaomi-tokenplan": "xiaomi-tokenplan",
};

export function parseModel(modelStr) {
  const parsed = parseModelCore(modelStr);
  if (parsed?.providerAlias && LOCAL_PROVIDER_ALIASES[parsed.providerAlias]) {
    return { ...parsed, provider: LOCAL_PROVIDER_ALIASES[parsed.providerAlias] };
  }
  return parsed;
}

/**
 * Resolve model alias from localDb
 */
export async function resolveModelAlias(alias) {
  const aliases = await getModelAliases();
  return resolveModelAliasFromMap(alias, aliases);
}

/**
 * Get full model info (parse or resolve)
 */
export async function getModelInfo(modelStr) {
  const parsed = parseModel(modelStr);

  if (!parsed.isAlias) {
    // Always check provider-node prefix matching using original input first
    const openaiNodes = await getProviderNodes({ type: "openai-compatible" });
    const matchedOpenAI = openaiNodes.find((node) => node.prefix === parsed.providerAlias);
    if (matchedOpenAI) {
      return { provider: matchedOpenAI.id, model: parsed.model };
    }

    const anthropicNodes = await getProviderNodes({ type: "anthropic-compatible" });
    const matchedAnthropic = anthropicNodes.find((node) => node.prefix === parsed.providerAlias);
    if (matchedAnthropic) {
      return { provider: matchedAnthropic.id, model: parsed.model };
    }

    const embeddingNodes = await getProviderNodes({ type: "custom-embedding" });
    const matchedEmbedding = embeddingNodes.find((node) => node.prefix === parsed.providerAlias);
    if (matchedEmbedding) {
      return { provider: matchedEmbedding.id, model: parsed.model };
    }
    return {
      provider: parsed.provider,
      model: parsed.model
    };
  }

  // Check if this is a combo name before resolving as alias
  // This prevents combo names from being incorrectly routed to providers
  const combo = await getComboByName(parsed.model);
  if (combo) {
    // Return null provider to signal this should be handled as combo
    // The caller (handleChat) will detect this and handle it as combo
    return { provider: null, model: parsed.model };
  }

  // Attempt alias resolution from the registry
  const aliases = await getModelAliases();
  const resolved = resolveModelAliasFromMap(parsed.model, aliases);
  if (resolved) {
    return resolved;
  }

  // All resolution methods exhausted (not provider/model format, not in alias registry,
  // not a combo name). Return null provider to signal resolution failure.
  // Per Requirement 2.4 and AGENTS.md: do NOT silently fall back or infer a provider.
  // A combo-name match alone is not enough — it must resolve to a valid provider/model target.
  return { provider: null, model: parsed.model };
}

/**
 * Check if model is a combo and get models list.
 *
 * A combo match succeeds only when it resolves to a valid actionable provider/model target.
 * If combo resolution ultimately fails (no valid models), returns null — the caller must
 * not treat the combo-name match alone as success.
 *
 * @returns {Promise<string[]|null>} Array of valid models or null if not a combo / combo has no valid targets
 */
export async function getComboModels(modelStr) {
  // Only check if it's not in provider/model format
  if (modelStr.includes("/")) return null;

  const combo = await getComboByName(modelStr);
  if (!combo || !combo.models || !Array.isArray(combo.models)) return null;

  // Filter to only valid actionable targets (non-empty strings)
  const validModels = combo.models.filter(
    (m) => typeof m === "string" && m.trim().length > 0
  );

  // A combo match succeeds only when it resolves to at least one valid actionable target
  if (validModels.length === 0) return null;

  return validModels;
}

/**
 * Return a descriptive error when a combo name is registered but has no valid targets.
 * @returns {Promise<string|null>}
 */
export async function getBrokenComboError(modelStr) {
  if (modelStr.includes("/")) return null;
  const combo = await getComboByName(modelStr);
  if (!combo) return null;
  const models = await getComboModels(modelStr);
  if (models) return null;
  return `Combo "${modelStr}" has no valid model targets configured.`;
}
