import { requireRouteAuth } from "@/sse/utils/routeAuth.js";
import { PROVIDER_MODELS, PROVIDER_ID_TO_ALIAS } from "@/shared/constants/models";
import {
  AI_PROVIDERS,
  getProviderAlias,
  isAnthropicCompatibleProvider,
  isOpenAICompatibleProvider,
} from "@/shared/constants/providers";
import { getProviderConnections, getCombos, getCustomModels, getModelAliases } from "@/lib/localDb";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { getDisabledModels } from "@/lib/disabledModelsDb";
import { resolveKiroModels } from "open-sse/services/kiroModels.js";
import { resolveQoderModels } from "open-sse/services/qoderModels.js";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import { validateProviderBaseUrl } from "open-sse/utils/ssrfGuardCore.js";

async function buildProxyOptionsFromConnection(conn) {
  const proxyConfig = await resolveConnectionProxyConfig(conn?.providerSpecificData || {});
  return {
    connectionProxyEnabled: proxyConfig.connectionProxyEnabled === true,
    connectionProxyUrl: proxyConfig.connectionProxyUrl || "",
    connectionNoProxy: proxyConfig.connectionNoProxy || "",
    vercelRelayUrl: proxyConfig.vercelRelayUrl || "",
    relayAuthSecret: proxyConfig.relayAuthSecret || "",
    strictProxy: proxyConfig.strictProxy,
    proxyRequiredUnavailable: proxyConfig.proxyRequiredUnavailable === true,
  };
}

// Per-provider live model resolvers. Each receives a connection record and
// returns { models: [{ id, name? }, ...] } | null on failure.
// Adding a provider here makes /v1/models prefer the live catalog for it.
const LIVE_MODEL_RESOLVERS = {
  kiro: async (conn) => {
    const proxyOptions = await buildProxyOptionsFromConnection(conn);
    const result = await resolveKiroModels({
      accessToken: conn.accessToken,
      refreshToken: conn.refreshToken,
      providerSpecificData: conn.providerSpecificData || {}
    }, { log: console, proxyOptions });
    return result?.models?.length ? { models: result.models } : null;
  },
  qoder: async (conn) => {
    const proxyOptions = await buildProxyOptionsFromConnection(conn);
    const result = await resolveQoderModels({
      accessToken: conn.accessToken,
      refreshToken: conn.refreshToken,
      email: conn.email,
      displayName: conn.displayName,
      providerSpecificData: conn.providerSpecificData || {}
    }, { log: console, proxyOptions });
    if (!result?.models?.length) return null;
    return {
      models: result.models.map((m) => ({ id: m.id, name: m.name })),
    };
  }
};

const parseOpenAIStyleModels = (data) => {
  if (Array.isArray(data)) return data;
  return data?.data || data?.models || data?.results || [];
};

// Matches provider IDs that are upstream/cross-instance connections (contain a UUID suffix)
const UPSTREAM_CONNECTION_RE = /[-_][0-9a-f]{8,}$/i;

// LLM kind sentinel — combos/models with no explicit kind default to LLM
const LLM_KIND = "llm";

// Map per-model `type` field (in PROVIDER_MODELS) to service kind.
// Models without `type` are treated as LLM.
const MODEL_TYPE_TO_KIND = {
  image: "image",
  tts: "tts",
  embedding: "embedding",
  stt: "stt",
  imageToText: "imageToText",
};

function modelKind(model) {
  if (!model?.type) return LLM_KIND;
  return MODEL_TYPE_TO_KIND[model.type] || LLM_KIND;
}

// For dynamic/unknown model IDs (compatible providers, alias map, custom models)
// fall back to provider-level kind matching when per-model type is unavailable.
function inferKindFromUnknownModelId(modelId) {
  const lower = String(modelId).toLowerCase();
  if (/embed/.test(lower)) return "embedding";
  if (/whisper|asr|transcri/.test(lower)) return "stt";
  if (/tts|speech|audio|voice/.test(lower)) return "tts";
  if (/image|imagen|dall-?e|flux|sdxl|sd-|stable-diffusion/.test(lower)) return "image";
  return LLM_KIND;
}

export class ModelsDbError extends Error {
  constructor(message) {
    super(message);
    this.name = "ModelsDbError";
  }
}

async function fetchCompatibleModelIds(connection, proxyOptions = null) {
  if (!connection?.apiKey) return [];

  let baseUrl = typeof connection?.providerSpecificData?.baseUrl === "string"
    ? connection.providerSpecificData.baseUrl.trim().replace(/\/$/, "")
    : "";

  if (!baseUrl) return [];
  try {
    baseUrl = validateProviderBaseUrl(baseUrl);
  } catch {
    return [];
  }

  let url = `${baseUrl}/models`;
  const headers = {
    "Content-Type": "application/json",
  };

  if (isOpenAICompatibleProvider(connection.provider)) {
    headers.Authorization = `Bearer ${connection.apiKey}`;
  } else if (isAnthropicCompatibleProvider(connection.provider)) {
    // Anthropic model discovery lives at <base>/models. When the saved base URL
    // already points at the chat endpoint (.../messages), swap the suffix for
    // /models instead of blindly appending (which produced .../messages/models).
    if (url.endsWith("/messages/models")) {
      url = `${url.slice(0, -"/messages/models".length)}/models`;
    }
    headers["x-api-key"] = connection.apiKey;
    headers["anthropic-version"] = "2023-06-01";
    headers.Authorization = `Bearer ${connection.apiKey}`;
  } else {
    return [];
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const response = await proxyAwareFetch(url, {
      method: "GET",
      headers,
      cache: "no-store",
      signal: controller.signal,
    }, proxyOptions);
    clearTimeout(timeoutId);

    if (!response.ok) return [];

    const data = await response.json();
    const rawModels = parseOpenAIStyleModels(data);

    return Array.from(
      new Set(
        rawModels
          .map((model) => model?.id || model?.name || model?.model)
          .filter((modelId) => typeof modelId === "string" && modelId.trim() !== "")
      )
    );
  } catch {
    return [];
  }
}

// Provider matches kindFilter when its serviceKinds intersect the requested kinds.
// LLM is the default kind for providers missing serviceKinds.
function providerMatchesKinds(providerId, kindFilter) {
  const provider = AI_PROVIDERS[providerId];
  const kinds = Array.isArray(provider?.serviceKinds) && provider.serviceKinds.length > 0
    ? provider.serviceKinds
    : [LLM_KIND];
  return kindFilter.some((k) => kinds.includes(k));
}

// Combo matches kindFilter when its `kind` field is in the list.
// Combos with no kind are treated as LLM.
function comboMatchesKinds(combo, kindFilter) {
  const kind = combo?.kind || LLM_KIND;
  return kindFilter.includes(kind);
}

/**
 * Build OpenAI-format models list filtered by service kinds.
 * @param {string[]} kindFilter - List of service kinds to include (e.g. ["llm"], ["webSearch","webFetch"]).
 */
export async function buildModelsList(kindFilter) {
  let connections = [];
  try {
    connections = await getProviderConnections();
    connections = connections.filter(c => c.isActive !== false);
  } catch (e) {
    console.log("Could not fetch providers:", e);
    throw new ModelsDbError(e?.message || "Database unavailable");
  }

  let combos = [];
  try {
    combos = await getCombos();
  } catch (e) {
    console.log("Could not fetch combos");
  }

  let customModels = [];
  try {
    customModels = await getCustomModels();
  } catch (e) {
    console.log("Could not fetch custom models");
  }

  let modelAliases = {};
  try {
    modelAliases = await getModelAliases();
  } catch (e) {
    console.log("Could not fetch model aliases");
  }

  let disabledByAlias = {};
  try {
    disabledByAlias = await getDisabledModels();
  } catch (e) {
    console.log("Could not fetch disabled models");
  }
  const isDisabled = (alias, modelId) => Array.isArray(disabledByAlias[alias]) && disabledByAlias[alias].includes(modelId);

  const activeConnectionByProvider = new Map();
  for (const conn of connections) {
    if (!activeConnectionByProvider.has(conn.provider)) {
      activeConnectionByProvider.set(conn.provider, conn);
    }
  }

  const models = [];

  // Combos first (filtered by kind). Web combos expose `kind` so AI knows search vs fetch.
  for (const combo of combos) {
    if (!comboMatchesKinds(combo, kindFilter)) continue;
    const entry = {
      id: combo.name,
      object: "model",
      owned_by: "combo",
    };
    if (combo.kind === "webSearch" || combo.kind === "webFetch") {
      entry.kind = combo.kind;
    }
    models.push(entry);
  }

  if (connections.length === 0) {
    // No active connections — expose registered aliases only (not the full static catalog).
    for (const [alias, target] of Object.entries(modelAliases)) {
      if (typeof target !== "string" || !target.trim()) continue;
      if (!kindFilter.includes(LLM_KIND)) continue;
      models.push({
        id: alias,
        object: "model",
        owned_by: "alias",
      });
    }
  } else {
    for (const [providerId, conn] of activeConnectionByProvider.entries()) {
      if (!providerMatchesKinds(providerId, kindFilter)) continue;

      const staticAlias = PROVIDER_ID_TO_ALIAS[providerId] || providerId;
      const outputAlias = (
        conn?.providerSpecificData?.prefix
        || getProviderAlias(providerId)
        || staticAlias
      ).trim();
      const providerModels = PROVIDER_MODELS[staticAlias] || [];
      const enabledModels = conn?.providerSpecificData?.enabledModels;
      const hasExplicitEnabledModels =
        Array.isArray(enabledModels) && enabledModels.length > 0;
      const isCompatibleProvider =
        isOpenAICompatibleProvider(providerId) || isAnthropicCompatibleProvider(providerId);

      // Build kind lookup for static models so we can filter even when only IDs are exposed
      const staticModelKindById = new Map(
        providerModels.map((m) => [m.id, modelKind(m)])
      );

      let rawModelIds = hasExplicitEnabledModels
        ? Array.from(
            new Set(
              enabledModels.filter(
                (modelId) => typeof modelId === "string" && modelId.trim() !== "",
              ),
            ),
          )
        : providerModels.map((model) => model.id);

      if (isCompatibleProvider && rawModelIds.length === 0 && !UPSTREAM_CONNECTION_RE.test(providerId)) {
        const proxyOptions = await buildProxyOptionsFromConnection(conn);
        rawModelIds = await fetchCompatibleModelIds(conn, proxyOptions);
      }

      // Config-driven live catalog override (e.g. Kiro returns dynamic
      // -thinking/-agentic variants per account). On failure, fall back to
      // whatever rawModelIds already holds.
      const liveResolver = LIVE_MODEL_RESOLVERS[providerId];
      if (liveResolver && !hasExplicitEnabledModels) {
        try {
          const live = await liveResolver(conn);
          if (live?.models?.length) {
            rawModelIds = live.models.map((m) => m.id);
          }
        } catch (err) {
          console.log(`Live model fetch failed for ${providerId}: ${err?.message || err}`);
        }
      }

      const modelIds = rawModelIds
        .map((modelId) => {
          if (modelId.startsWith(`${outputAlias}/`)) {
            return modelId.slice(outputAlias.length + 1);
          }
          if (modelId.startsWith(`${staticAlias}/`)) {
            return modelId.slice(staticAlias.length + 1);
          }
          if (modelId.startsWith(`${providerId}/`)) {
            return modelId.slice(providerId.length + 1);
          }
          return modelId;
        })
        .filter((modelId) => typeof modelId === "string" && modelId.trim() !== "");

      const customModelKindById = new Map();
      const customModelIds = customModels
        .filter((m) => {
          if (!m?.id) return false;
          const kind = modelKind(m);
          if (!kindFilter.includes(kind)) return false;
          const alias = m.providerAlias;
          return alias === staticAlias || alias === outputAlias || alias === providerId;
        })
        .map((m) => {
          const modelId = String(m.id).trim();
          if (modelId) customModelKindById.set(modelId, modelKind(m));
          return modelId;
        })
        .filter((modelId) => modelId !== "");

      const aliasModelIds = Object.values(modelAliases || {})
        .filter((fullModel) => {
          if (typeof fullModel !== "string" || !fullModel.includes("/")) return false;
          return (
            fullModel.startsWith(`${outputAlias}/`) ||
            fullModel.startsWith(`${staticAlias}/`) ||
            fullModel.startsWith(`${providerId}/`)
          );
        })
        .map((fullModel) => {
          if (fullModel.startsWith(`${outputAlias}/`)) {
            return fullModel.slice(outputAlias.length + 1);
          }
          if (fullModel.startsWith(`${staticAlias}/`)) {
            return fullModel.slice(staticAlias.length + 1);
          }
          if (fullModel.startsWith(`${providerId}/`)) {
            return fullModel.slice(providerId.length + 1);
          }
          return fullModel;
        })
        .filter((modelId) => typeof modelId === "string" && modelId.trim() !== "");

      const mergedModelIds = Array.from(new Set([...modelIds, ...customModelIds, ...aliasModelIds]));

      for (const modelId of mergedModelIds) {
        // Resolve kind: prefer static metadata, otherwise infer from ID heuristics
        const kind = staticModelKindById.get(modelId) || customModelKindById.get(modelId) || inferKindFromUnknownModelId(modelId);
        if (!kindFilter.includes(kind)) continue;
        if (isDisabled(outputAlias, modelId) || isDisabled(staticAlias, modelId)) continue;

        models.push({
          id: `${outputAlias}/${modelId}`,
          object: "model",
          owned_by: outputAlias,
        });
      }

      // Merge sub-config models (TTS / embedding) that live on AI_PROVIDERS, not PROVIDER_MODELS
      const providerInfo = AI_PROVIDERS[providerId];
      const subConfigModels = [];
      if (kindFilter.includes("tts") && Array.isArray(providerInfo?.ttsConfig?.models)) {
        for (const m of providerInfo.ttsConfig.models) {
          if (m?.id) subConfigModels.push(m.id);
        }
      }
      if (kindFilter.includes("embedding") && Array.isArray(providerInfo?.embeddingConfig?.models)) {
        for (const m of providerInfo.embeddingConfig.models) {
          if (m?.id) subConfigModels.push(m.id);
        }
      }
      for (const subId of subConfigModels) {
        if (isDisabled(outputAlias, subId) || isDisabled(staticAlias, subId)) continue;
        models.push({
          id: `${outputAlias}/${subId}`,
          object: "model",
          owned_by: outputAlias,
        });
      }

      // Web search/fetch — provider IS the model, expose as {alias}/search and/or {alias}/fetch with explicit kind
      if (kindFilter.includes("webSearch") && providerInfo?.searchConfig) {
        models.push({
          id: `${outputAlias}/search`,
          object: "model",
          kind: "webSearch",
          owned_by: outputAlias,
        });
      }
      if (kindFilter.includes("webFetch") && providerInfo?.fetchConfig) {
        models.push({
          id: `${outputAlias}/fetch`,
          object: "model",
          kind: "webFetch",
          owned_by: outputAlias,
        });
      }
    }
  }

  const dedupedModels = [];
  const seenModelIds = new Set();
  for (const model of models) {
    if (!model?.id || seenModelIds.has(model.id)) continue;
    seenModelIds.add(model.id);
    dedupedModels.push(model);
  }

  return dedupedModels;
}

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/**
 * GET /v1/models - OpenAI compatible models list (LLM/chat models only by default).
 * For other capabilities use /v1/models/{kind} (image, tts, stt, embedding, image-to-text, web).
 */
export async function GET(request) {
  const routeAuth = await requireRouteAuth(request);
  if (!routeAuth.ok) return routeAuth.response;

  try {
    const data = await buildModelsList([LLM_KIND]);
    return Response.json({ object: "list", data }, {
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  } catch (error) {
    if (error instanceof ModelsDbError) {
      return Response.json(
        { error: { message: error.message, type: "service_unavailable" } },
        { status: 503, headers: { "Access-Control-Allow-Origin": "*" } }
      );
    }
    console.log("Error fetching models:", error);
    return Response.json(
      { error: { message: error.message, type: "server_error" } },
      { status: 500 }
    );
  }
}
