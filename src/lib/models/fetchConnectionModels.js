import { isOpenAICompatibleProvider, isAnthropicCompatibleProvider } from "@/shared/constants/providers";
import { ANTIGRAVITY_CONFIG, GEMINI_CONFIG } from "@/lib/oauth/constants/oauth";
import { getPlatformUserAgent } from "open-sse/config/appConstants.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import {
  checkAndRefreshToken,
  refreshCopilotToken,
  refreshTokenByProvider,
  updateProviderCredentials,
} from "@/sse/services/tokenRefresh";
import { resolveOllamaLocalHost } from "open-sse/config/providers.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { resolveKiroModels } from "open-sse/services/kiroModels.js";
import { resolveQoderModels } from "open-sse/services/qoderModels.js";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import { refreshGoogleToken as refreshGoogleTokenWithProxy } from "open-sse/services/tokenRefresh.js";
import { getProviderModels } from "open-sse/config/providerModels.js";

async function buildProxyOptionsFromConnection(connection) {
  const proxyConfig = await resolveConnectionProxyConfig(connection?.providerSpecificData || {});
  return {
    connectionProxyEnabled: proxyConfig.connectionProxyEnabled === true,
    connectionProxyUrl: proxyConfig.connectionProxyUrl || "",
    connectionNoProxy: proxyConfig.connectionNoProxy || "",
    vercelRelayUrl: proxyConfig.vercelRelayUrl || "",
    strictProxy: proxyConfig.strictProxy === true,
  };
}

const GEMINI_CLI_MODELS_URL = "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels";
const ANTIGRAVITY_MODELS_URL = `${ANTIGRAVITY_CONFIG.apiEndpoint}/${ANTIGRAVITY_CONFIG.apiVersion}:fetchAvailableModels`;

function normalizeCloudCodeProjectId(project) {
  if (typeof project === "string") return project.trim() || null;
  if (project && typeof project === "object" && typeof project.id === "string") {
    return project.id.trim() || null;
  }
  return null;
}

async function resolveAntigravityProjectId(connection, accessToken, proxyOptions) {
  let projectId = normalizeCloudCodeProjectId(connection.projectId)
    || normalizeCloudCodeProjectId(connection.providerSpecificData?.projectId);
  if (projectId) return projectId;
  if (!connection.id || !accessToken) return null;

  const fetched = await getProjectIdForConnection(connection.id, accessToken, proxyOptions);
  if (!fetched) return null;

  connection.projectId = fetched;
  await updateProviderCredentials(connection.id, { projectId: fetched });
  return fetched;
}

const parseOpenAIStyleModels = (data) => {
  if (Array.isArray(data)) return data;
  return data?.data || data?.models || data?.results || [];
};

const parseGeminiCliModels = (data) => {
  if (Array.isArray(data?.models)) {
    return data.models
      .map((item) => {
        const id = item?.id || item?.model || item?.name;
        if (!id) return null;
        return { id, name: item?.displayName || item?.name || id };
      })
      .filter(Boolean);
  }

  if (data?.models && typeof data.models === "object") {
    return Object.entries(data.models)
      .filter(([, info]) => !info?.isInternal)
      .map(([id, info]) => ({
        id,
        name: info?.displayName || info?.name || id,
      }));
  }

  return [];
};

const appendCodexReviewModels = (models) => models.flatMap((model) => {
  const id = model?.id || model?.slug || model?.model || model?.name;
  if (!id) return [];
  const name = model?.display_name || model?.displayName || model?.name || id;
  const normalized = { ...model, id, name };
  const isChatModel = (model?.type || "llm") !== "image" && !id.toLowerCase().includes("embed");
  if (!isChatModel || id.endsWith("-review")) return [normalized];
  return [
    normalized,
    {
      ...normalized,
      id: `${id}-review`,
      name: `${name} Review`,
      upstreamModelId: id,
      quotaFamily: "review",
    },
  ];
});

const parseCodexModels = (data) => appendCodexReviewModels(parseOpenAIStyleModels(data));

const parseCloudflareModels = (data) => {
  const openRouterModels = parseOpenAIStyleModels(data);
  if (openRouterModels.length > 0) {
    return openRouterModels
      .map((model) => {
        const id = model?.id || model?.name;
        if (!id) return null;
        return { id, name: model?.name || id };
      })
      .filter(Boolean);
  }

  const result = Array.isArray(data?.result) ? data.result : [];
  return result
    .map((item) => {
      const id = item?.name || item?.id || item?.model;
      if (!id) return null;
      return { id, name: item?.display_name || item?.title || id };
    })
    .filter(Boolean);
};

const getStaticCloudflareModels = () => getProviderModels("cloudflare-ai").map((model) => ({
  id: model.id,
  name: model.name,
}));

const createOpenAIModelsConfig = (url) => ({
  url,
  method: "GET",
  headers: { "Content-Type": "application/json" },
  authHeader: "Authorization",
  authPrefix: "Bearer ",
  parseResponse: parseOpenAIStyleModels,
});

const resolveQwenModelsUrl = (connection) => {
  const fallback = "https://portal.qwen.ai/v1/models";
  const raw = connection?.providerSpecificData?.resourceUrl;
  if (!raw || typeof raw !== "string") return fallback;
  const value = raw.trim();
  if (!value) return fallback;
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return `${value.replace(/\/$/, "")}/models`;
  }
  return `https://${value.replace(/\/$/, "")}/v1/models`;
};

const buildOAuthResolver = ({ refreshFn, fetchFn, parseFn, errorLabel }) => async (connection) => {
  const { accessToken, refreshToken } = connection;
  if (!accessToken) {
    return { error: "No valid token found", status: 401 };
  }
  const proxyOptions = await buildProxyOptionsFromConnection(connection);
  let warning;
  try {
    let response = await fetchFn(accessToken, connection, proxyOptions);
    if (!response.ok && (response.status === 401 || response.status === 403) && refreshToken) {
      const refreshed = await refreshFn(connection, proxyOptions);
      if (refreshed?.accessToken) {
        await updateProviderCredentials(connection.id, {
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken || refreshToken,
          expiresIn: refreshed.expiresIn,
        });
        connection.accessToken = refreshed.accessToken;
        if (refreshed.refreshToken) connection.refreshToken = refreshed.refreshToken;
        response = await fetchFn(refreshed.accessToken, connection, proxyOptions);
      }
    }
    if (response.ok) {
      const data = await response.json();
      const models = parseFn(data);
      if (models.length > 0) return { models };
    } else {
      const errorText = await response.text();
      warning = `${errorLabel}: ${response.status} ${errorText}`;
      console.log(`${errorLabel} (falling back to static):`, errorText);
    }
  } catch (error) {
    warning = `${errorLabel}: ${error.message}`;
    console.log(`${errorLabel} (falling back to static):`, error.message);
  }
  return { models: [], warning };
};

const PROVIDER_MODELS_CONFIG = {
  claude: {
    url: "https://api.anthropic.com/v1/models",
    method: "GET",
    headers: {
      "Anthropic-Version": "2023-06-01",
      "Content-Type": "application/json",
    },
    authHeader: "x-api-key",
    parseResponse: (data) => data.data || [],
  },
  gemini: {
    url: "https://generativelanguage.googleapis.com/v1beta/models",
    method: "GET",
    headers: { "Content-Type": "application/json" },
    authQuery: "key",
    parseResponse: (data) => data.models || [],
  },
  qwen: {
    url: "https://portal.qwen.ai/v1/models",
    method: "GET",
    headers: { "Content-Type": "application/json" },
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    parseResponse: (data) => data.data || [],
  },
  codex: {
    url: "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0",
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      originator: "codex-cli",
      "User-Agent": "codex-cli/1.0.18 (macOS; arm64)",
    },
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    parseResponse: parseCodexModels,
  },
  antigravity: {
    customResolver: buildOAuthResolver({
      refreshFn: (conn, proxyOptions) => refreshGoogleTokenWithProxy(
        conn.refreshToken,
        ANTIGRAVITY_CONFIG.clientId,
        ANTIGRAVITY_CONFIG.clientSecret,
        console,
        proxyOptions,
      ),
      fetchFn: async (token, conn, proxyOptions) => {
        const projectId = await resolveAntigravityProjectId(conn, token, proxyOptions);
        const body = projectId ? { project: projectId } : {};
        return proxyAwareFetch(ANTIGRAVITY_MODELS_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "User-Agent": getPlatformUserAgent(),
            "X-Client-Name": "antigravity",
            "X-Client-Version": "1.107.0",
            "x-request-source": "local",
          },
          body: JSON.stringify(body),
        }, proxyOptions);
      },
      parseFn: parseGeminiCliModels,
      errorLabel: "Failed to fetch Antigravity models",
    }),
  },
  github: {
    url: "https://api.githubcopilot.com/models",
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "Copilot-Integration-Id": "vscode-chat",
      "editor-version": "vscode/1.107.1",
      "editor-plugin-version": "copilot-chat/0.26.7",
      "user-agent": "GitHubCopilotChat/0.26.7",
    },
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    parseResponse: (data) => {
      if (!data?.data) return [];
      return data.data
        .filter((m) => m.capabilities?.type === "chat")
        .filter((m) => m.policy?.state !== "disabled")
        .map((m) => ({
          id: m.id,
          name: m.name || m.id,
          version: m.version,
          capabilities: m.capabilities,
          isDefault: m.model_picker_enabled === true,
        }));
    },
  },
  openai: createOpenAIModelsConfig("https://api.openai.com/v1/models"),
  openrouter: createOpenAIModelsConfig("https://openrouter.ai/api/v1/models"),
  anthropic: {
    url: "https://api.anthropic.com/v1/models",
    method: "GET",
    headers: {
      "Anthropic-Version": "2023-06-01",
      "Content-Type": "application/json",
    },
    authHeader: "x-api-key",
    parseResponse: (data) => data.data || [],
  },
  alicode: {
    url: "https://coding.dashscope.aliyuncs.com/v1/models",
    method: "GET",
    headers: { "Content-Type": "application/json" },
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    parseResponse: (data) => data.data || [],
  },
  "alicode-intl": {
    url: "https://coding-intl.dashscope.aliyuncs.com/v1/models",
    method: "GET",
    headers: { "Content-Type": "application/json" },
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    parseResponse: (data) => data.data || [],
  },
  "volcengine-ark": createOpenAIModelsConfig("https://ark.cn-beijing.volces.com/api/coding/v3/models"),
  byteplus: createOpenAIModelsConfig("https://ark.ap-southeast.bytepluses.com/api/coding/v3/models"),
  deepseek: createOpenAIModelsConfig("https://api.deepseek.com/models"),
  groq: createOpenAIModelsConfig("https://api.groq.com/openai/v1/models"),
  xai: createOpenAIModelsConfig("https://api.x.ai/v1/models"),
  mistral: createOpenAIModelsConfig("https://api.mistral.ai/v1/models"),
  perplexity: createOpenAIModelsConfig("https://api.perplexity.ai/models"),
  together: createOpenAIModelsConfig("https://api.together.xyz/v1/models"),
  fireworks: createOpenAIModelsConfig("https://api.fireworks.ai/inference/v1/models"),
  cerebras: createOpenAIModelsConfig("https://api.cerebras.ai/v1/models"),
  cohere: createOpenAIModelsConfig("https://api.cohere.ai/v1/models"),
  nebius: createOpenAIModelsConfig("https://api.studio.nebius.ai/v1/models"),
  siliconflow: createOpenAIModelsConfig("https://api.siliconflow.cn/v1/models"),
  hyperbolic: createOpenAIModelsConfig("https://api.hyperbolic.xyz/v1/models"),
  ollama: createOpenAIModelsConfig("https://ollama.com/api/tags"),
  nanobanana: createOpenAIModelsConfig("https://api.nanobananaapi.ai/v1/models"),
  chutes: createOpenAIModelsConfig("https://llm.chutes.ai/v1/models"),
  nvidia: createOpenAIModelsConfig("https://integrate.api.nvidia.com/v1/models"),
  assemblyai: createOpenAIModelsConfig("https://api.assemblyai.com/v1/models"),
  "vercel-ai-gateway": createOpenAIModelsConfig("https://ai-gateway.vercel.sh/v1/models"),
  kiro: {
    customResolver: async (connection) => {
      const credentials = {
        accessToken: connection.accessToken,
        refreshToken: connection.refreshToken,
        providerSpecificData: connection.providerSpecificData || {},
      };
      const proxyOptions = await buildProxyOptionsFromConnection(connection);
      let warning;
      try {
        const result = await resolveKiroModels(credentials, {
          log: console,
          proxyOptions,
          onCredentialsRefreshed: async (refreshed) => {
            if (refreshed?.accessToken) {
              await updateProviderCredentials(connection.id, {
                accessToken: refreshed.accessToken,
                refreshToken: refreshed.refreshToken || connection.refreshToken,
                expiresIn: refreshed.expiresIn,
              });
              connection.accessToken = refreshed.accessToken;
              if (refreshed.refreshToken) connection.refreshToken = refreshed.refreshToken;
            }
          },
        });
        if (result?.models?.length) {
          return {
            models: result.models.map((m) => ({
              id: m.id,
              name: m.name,
              upstreamModelId: m.upstreamModelId,
              contextLength: m.contextLength,
              rateMultiplier: m.rateMultiplier,
              capabilities: m.capabilities,
              description: m.description,
            })),
          };
        }
        warning = "Kiro returned no models; falling back to static catalog.";
      } catch (error) {
        warning = `Failed to fetch Kiro models: ${error.message}`;
        console.log("Failed to fetch Kiro models dynamically, falling back to static:", error.message);
      }
      return { models: [], warning };
    },
  },
  qoder: {
    customResolver: async (connection) => {
      const credentials = {
        accessToken: connection.accessToken,
        refreshToken: connection.refreshToken,
        email: connection.email,
        displayName: connection.displayName,
        providerSpecificData: connection.providerSpecificData || {},
      };
      const proxyOptions = await buildProxyOptionsFromConnection(connection);
      let warning;
      try {
        const result = await resolveQoderModels(credentials, { forceRefresh: true, log: console, proxyOptions });
        if (result?.models?.length) {
          return {
            models: result.models.map((m) => ({
              id: `qoder/${m.id}`,
              name: m.name,
              contextLength: m.contextLength,
              isVL: m.isVL,
              isReasoning: m.isReasoning,
              maxOutputTokens: m.maxOutputTokens,
              description: m.description,
            })),
          };
        }
        warning = "Qoder returned no models; falling back to static catalog.";
      } catch (error) {
        warning = `Failed to fetch Qoder models: ${error.message}`;
        console.log("Failed to fetch Qoder models dynamically, falling back to static:", error.message);
      }
      return { models: [], warning };
    },
  },
  "gemini-cli": {
    customResolver: buildOAuthResolver({
      refreshFn: (conn, proxyOptions) => refreshGoogleTokenWithProxy(
        conn.refreshToken,
        GEMINI_CONFIG.clientId,
        GEMINI_CONFIG.clientSecret,
        console,
        proxyOptions,
      ),
      fetchFn: (token, conn, proxyOptions) => {
        const projectId = conn.projectId || conn.providerSpecificData?.projectId;
        const body = projectId ? { project: projectId } : {};
        return proxyAwareFetch(GEMINI_CLI_MODELS_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            "User-Agent": "google-api-nodejs-client/9.15.1",
            "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
          },
          body: JSON.stringify(body),
        }, proxyOptions);
      },
      parseFn: parseGeminiCliModels,
      errorLabel: "Failed to fetch Gemini CLI models",
    }),
  },
  "ollama-local": {
    customResolver: async (connection) => {
      const proxyOptions = await buildProxyOptionsFromConnection(connection);
      const url = `${resolveOllamaLocalHost(connection)}/api/tags`;
      const response = await proxyAwareFetch(url, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      }, proxyOptions);
      if (!response.ok) {
        const errorText = await response.text();
        console.log("Error fetching models from ollama-local:", errorText);
        return { error: `Failed to fetch models: ${response.status}`, status: response.status };
      }
      const data = await response.json();
      return { models: parseOpenAIStyleModels(data) };
    },
  },
  "cloudflare-ai": {
    customResolver: async (connection) => {
      const accountId = connection.providerSpecificData?.accountId?.trim();
      const apiKey = connection.apiKey;
      if (!accountId) {
        return { error: "Missing Account ID", status: 400 };
      }
      if (!apiKey) {
        return { error: "No valid token found", status: 401 };
      }

      const proxyOptions = await buildProxyOptionsFromConnection(connection);
      const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/models/search?format=openrouter&per_page=100`;

      try {
        const response = await proxyAwareFetch(url, {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
        }, proxyOptions);

        if (response.ok) {
          const data = await response.json();
          const models = parseCloudflareModels(data);
          if (models.length > 0) {
            return { models };
          }
          return {
            models: getStaticCloudflareModels(),
            warning: "Cloudflare returned no models; using static catalog.",
          };
        }

        const errorText = await response.text();
        console.log("Error fetching models from cloudflare-ai:", errorText);
        if (response.status === 401 || response.status === 403) {
          return {
            error: formatModelsFetchError(response.status, "cloudflare-ai"),
            status: response.status,
          };
        }

        return {
          models: getStaticCloudflareModels(),
          warning: `Failed to fetch Cloudflare models: ${response.status}`,
        };
      } catch (error) {
        console.log("Failed to fetch Cloudflare models (falling back to static):", error.message);
        return {
          models: getStaticCloudflareModels(),
          warning: `Failed to fetch Cloudflare models: ${error.message}`,
        };
      }
    },
  },
};

function connectionToCredentials(connection) {
  return {
    connectionId: connection.id,
    accessToken: connection.accessToken,
    refreshToken: connection.refreshToken,
    apiKey: connection.apiKey,
    expiresAt: connection.expiresAt,
    projectId: connection.projectId,
    providerSpecificData: connection.providerSpecificData || {},
  };
}

function applyRefreshedCredentials(connection, refreshed) {
  if (!refreshed) return;
  if (refreshed.accessToken) connection.accessToken = refreshed.accessToken;
  if (refreshed.refreshToken) connection.refreshToken = refreshed.refreshToken;
  if (refreshed.expiresAt) connection.expiresAt = refreshed.expiresAt;
  if (refreshed.providerSpecificData) {
    connection.providerSpecificData = {
      ...(connection.providerSpecificData || {}),
      ...refreshed.providerSpecificData,
    };
  }
}

function formatModelsFetchError(status, provider) {
  if (status === 401 || status === 403) {
    return `Provider session expired — reconnect ${provider} or refresh credentials`;
  }
  return `Failed to fetch models: ${status}`;
}

async function ensureFreshConnectionCredentials(connection) {
  const refreshed = await checkAndRefreshToken(
    connection.provider,
    connectionToCredentials(connection),
  );
  if (refreshed?._tokenRefreshFailed) return false;
  applyRefreshedCredentials(connection, refreshed);
  return true;
}

async function retryConnectionAuthRefresh(connection) {
  const provider = connection.provider;

  if (provider === "github" && connection.accessToken) {
    const copilotToken = await refreshCopilotToken(connection.accessToken);
    if (copilotToken?.token) {
      const providerSpecificData = {
        ...(connection.providerSpecificData || {}),
        copilotToken: copilotToken.token,
        copilotTokenExpiresAt: copilotToken.expiresAt,
      };
      await updateProviderCredentials(connection.id, {
        existingProviderSpecificData: connection.providerSpecificData,
        providerSpecificData,
      });
      connection.providerSpecificData = providerSpecificData;
      return true;
    }
  }

  if (!connection.refreshToken) return false;

  const refreshed = await refreshTokenByProvider(provider, connectionToCredentials(connection));
  if (!refreshed?.accessToken) return false;

  let providerSpecificData = refreshed.providerSpecificData;
  if (provider === "github") {
    const copilotToken = await refreshCopilotToken(refreshed.accessToken);
    if (copilotToken?.token) {
      providerSpecificData = {
        ...(connection.providerSpecificData || {}),
        copilotToken: copilotToken.token,
        copilotTokenExpiresAt: copilotToken.expiresAt,
      };
    }
  }

  await updateProviderCredentials(connection.id, {
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken || connection.refreshToken,
    expiresIn: refreshed.expiresIn,
    existingProviderSpecificData: connection.providerSpecificData,
    ...(providerSpecificData ? { providerSpecificData } : {}),
  });

  connection.accessToken = refreshed.accessToken;
  if (refreshed.refreshToken) connection.refreshToken = refreshed.refreshToken;
  if (providerSpecificData) connection.providerSpecificData = providerSpecificData;
  return true;
}

function resolveAuthToken(connection, config) {
  const provider = connection.provider;
  const authType = connection.authType;

  if (provider === "github") {
    return connection.providerSpecificData?.copilotToken
      || connection.accessToken
      || connection.apiKey;
  }

  const prefersApiKey = authType === "apikey"
    || authType === "api_key"
    || config?.authQuery === "key";

  if (prefersApiKey) {
    return connection.apiKey || connection.accessToken;
  }

  if (authType === "oauth" || authType === "access_token") {
    return connection.accessToken || connection.apiKey;
  }

  return connection.accessToken || connection.apiKey;
}

async function ensureGithubCopilotToken(connection) {
  if (connection.provider !== "github") return true;
  if (connection.providerSpecificData?.copilotToken) return true;
  if (!connection.accessToken) return false;

  const copilotToken = await refreshCopilotToken(connection.accessToken);
  if (!copilotToken?.token) return false;

  const providerSpecificData = {
    ...(connection.providerSpecificData || {}),
    copilotToken: copilotToken.token,
    copilotTokenExpiresAt: copilotToken.expiresAt,
  };
  await updateProviderCredentials(connection.id, {
    existingProviderSpecificData: connection.providerSpecificData,
    providerSpecificData,
  });
  connection.providerSpecificData = providerSpecificData;
  return true;
}

/** Match executor/buildProviderHeaders: API key vs OAuth Bearer for Anthropic. */
function applyAnthropicModelsAuth(connection, headers) {
  if (connection.apiKey) {
    headers["x-api-key"] = connection.apiKey;
    return true;
  }
  if (connection.accessToken) {
    headers.Authorization = `Bearer ${connection.accessToken}`;
    const beta = headers["Anthropic-Beta"] || headers["anthropic-beta"] || "";
    const flags = new Set(beta.split(",").map((f) => f.trim()).filter(Boolean));
    flags.add("oauth-2025-04-20");
    headers["anthropic-beta"] = [...flags].join(",");
    delete headers["Anthropic-Beta"];
    return true;
  }
  return false;
}

function buildProviderModelsRequest(connection, config) {
  const token = resolveAuthToken(connection, config);
  if (!token) return { error: "No valid token found", status: 401 };

  let url = config.url;
  if (connection.provider === "qwen") {
    url = resolveQwenModelsUrl(connection);
  }

  const headers = { ...config.headers };
  const usesAnthropicAuth = connection.provider === "claude" || connection.provider === "anthropic";
  if (usesAnthropicAuth) {
    if (!applyAnthropicModelsAuth(connection, headers)) {
      return { error: "No valid token found", status: 401 };
    }
  } else if (config.authQuery) {
    url += `?${config.authQuery}=${token}`;
  } else if (config.authHeader) {
    headers[config.authHeader] = (config.authPrefix || "") + token;
  }

  const fetchOptions = { method: config.method, headers };
  if (config.body && config.method === "POST") {
    fetchOptions.body = JSON.stringify(config.body);
  }

  return { url, fetchOptions, token };
}

async function fetchProviderModelsWithConfig(connection, config, proxyOptions, { retried = false } = {}) {
  const request = buildProviderModelsRequest(connection, config);
  if (request.error) return request;

  const response = await proxyAwareFetch(request.url, request.fetchOptions, proxyOptions);
  if (response.ok) {
    const data = await response.json();
    return { models: config.parseResponse(data) };
  }

  if (!retried && (response.status === 401 || response.status === 403)) {
    const refreshed = await retryConnectionAuthRefresh(connection);
    if (refreshed) {
      return fetchProviderModelsWithConfig(connection, config, proxyOptions, { retried: true });
    }
  }

  const errorText = await response.text();
  console.log(`Error fetching models from ${connection.provider}:`, errorText);
  return {
    error: formatModelsFetchError(response.status, connection.provider),
    status: response.status,
  };
}

/**
 * Fetch upstream model list for a provider connection.
 * @returns {Promise<{ models?: Array, warning?: string, error?: string, status?: number }>}
 */
export async function fetchModelsForConnection(connection) {
  if (!connection) {
    return { error: "Connection not found", status: 404 };
  }

  await ensureFreshConnectionCredentials(connection);
  await ensureGithubCopilotToken(connection);

  const proxyOptions = await buildProxyOptionsFromConnection(connection);

  if (isOpenAICompatibleProvider(connection.provider)) {
    const baseUrl = connection.providerSpecificData?.baseUrl;
    if (!baseUrl) {
      return { error: "No base URL configured for OpenAI compatible provider", status: 400 };
    }
    const url = `${baseUrl.replace(/\/$/, "")}/models`;
    const response = await proxyAwareFetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${connection.apiKey}`,
      },
    }, proxyOptions);

    if (!response.ok) {
      const errorText = await response.text();
      console.log(`Error fetching models from ${connection.provider}:`, errorText);
      return { error: `Failed to fetch models: ${response.status}`, status: response.status };
    }

    const data = await response.json();
    return { models: data.data || data.models || [] };
  }

  if (isAnthropicCompatibleProvider(connection.provider)) {
    let baseUrl = connection.providerSpecificData?.baseUrl;
    if (!baseUrl) {
      return { error: "No base URL configured for Anthropic compatible provider", status: 400 };
    }

    baseUrl = baseUrl.replace(/\/$/, "");
    if (baseUrl.endsWith("/messages")) {
      baseUrl = baseUrl.slice(0, -9);
    }

    const url = `${baseUrl}/models`;
    const response = await proxyAwareFetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": connection.apiKey,
        "anthropic-version": "2023-06-01",
        Authorization: `Bearer ${connection.apiKey}`,
      },
    }, proxyOptions);

    if (!response.ok) {
      const errorText = await response.text();
      console.log(`Error fetching models from ${connection.provider}:`, errorText);
      return { error: `Failed to fetch models: ${response.status}`, status: response.status };
    }

    const data = await response.json();
    return { models: data.data || data.models || [] };
  }

  const config = PROVIDER_MODELS_CONFIG[connection.provider];
  if (!config) {
    return {
      error: `Provider ${connection.provider} does not support models listing`,
      status: 400,
    };
  }

  if (typeof config.customResolver === "function") {
    return config.customResolver(connection);
  }

  return fetchProviderModelsWithConfig(connection, config, proxyOptions);
}
