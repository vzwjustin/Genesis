import { getModelRequestExtras, getModelsByProviderId } from "../config/providerModels.js";

export function isFusionProvider(provider) {
  return provider === "fusion";
}

function cloneJson(value) {
  return value == null ? null : JSON.parse(JSON.stringify(value));
}

function resolveFusionCatalogModel(alias, model) {
  const models = getModelsByProviderId(alias);
  if (models.some((entry) => entry.id === model)) return model;
  const fromUpstream = models.find((entry) => entry.upstreamModelId === model);
  if (fromUpstream) return fromUpstream.id;
  if (model === "openrouter/fusion") return "fusion";
  return model;
}

function readAnalysisModels(savedFusion) {
  if (Array.isArray(savedFusion?.analysis_models)) return savedFusion.analysis_models;
  if (Array.isArray(savedFusion?.analysisModels)) return savedFusion.analysisModels;
  return null;
}

function readMaxToolCalls(savedFusion) {
  if (Number.isFinite(savedFusion?.max_tool_calls)) return savedFusion.max_tool_calls;
  if (Number.isFinite(savedFusion?.maxToolCalls)) return savedFusion.maxToolCalls;
  return null;
}

/**
 * Build OpenRouter Fusion plugins for upstream unless the client already sent plugins.
 * Merges connection-specific overrides onto the catalog preset (Quality/Budget).
 * Returns undefined when deliberation is disabled or no plugin config applies.
 */
export function resolveFusionPlugins({ savedFusion, alias, model }) {
  if (savedFusion && typeof savedFusion === "object" && savedFusion.enabled === false) {
    return undefined;
  }

  const catalogModel = resolveFusionCatalogModel(alias, model);
  const extras = getModelRequestExtras(alias, catalogModel);
  const basePlugin = cloneJson(extras?.plugins?.[0]) || { id: "fusion" };

  if (savedFusion && typeof savedFusion === "object") {
    const plugin = { ...basePlugin };
    const analysisModels = readAnalysisModels(savedFusion);
    if (analysisModels?.length > 0) {
      plugin.analysis_models = analysisModels;
    }
    const judge = savedFusion.model;
    if (typeof judge === "string" && judge.trim()) {
      plugin.model = judge.trim();
    }
    const maxToolCalls = readMaxToolCalls(savedFusion);
    if (maxToolCalls != null) {
      plugin.max_tool_calls = maxToolCalls;
    }
    return [plugin];
  }

  if (extras?.plugins?.length > 0) {
    return cloneJson(extras.plugins);
  }

  return undefined;
}
