import { BaseExecutor } from "./base.js";
import { PROVIDERS, resolveXiaomiTokenplanBaseUrl } from "../config/providers.js";
import { validateProviderBaseUrl } from "../utils/ssrfGuard.js";
import { OAUTH_ENDPOINTS, buildKimiHeaders } from "../config/appConstants.js";
import { buildClineHeaders } from "../../src/shared/utils/clineAuth.js";
import { getCachedClaudeHeaders, extractPassthroughAnthropicHeaders } from "../utils/claudeHeaderCache.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";
import { hasAnthropicCacheBreakpoints } from "../rtk/cacheBoundary.js";

export class DefaultExecutor extends BaseExecutor {
  constructor(provider) {
    const config = PROVIDERS[provider];
    super(
      provider,
      config ?? {
        format: "openai",
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  transformRequest(model, body) {
    const withReasoning = injectReasoningContent({ provider: this.provider, model, body });
    const result = hasAnthropicCacheBreakpoints(body)
      ? withReasoning
      : this.applyJsonSchemaFallback(withReasoning);
    // Cerebras 400 (wrong_api_format) / Mistral 422 (extra_forbidden) on client_metadata.
    if (result && typeof result === "object" && (this.provider === "cerebras" || this.provider === "mistral")) {
      delete result.client_metadata;
    }
    // claude-opus-4 series: temperature is deprecated upstream (Anthropic 400). #1748
    if (result && typeof result === "object" && /claude-opus-4/i.test(model || "") && result.temperature !== undefined) {
      delete result.temperature;
    }
    return result;
  }

  // Fallback json_schema → json_object for openai-compatible providers without native Structured Output.
  applyJsonSchemaFallback(body) {
    if (!this.provider?.startsWith?.("openai-compatible-")) return body;
    const rf = body?.response_format;
    if (rf?.type !== "json_schema" || !rf.json_schema?.schema) return body;

    const schemaJson = JSON.stringify(rf.json_schema.schema, null, 2);
    const prompt = `You must respond with valid JSON that strictly follows this JSON schema:\n\`\`\`json\n${schemaJson}\n\`\`\`\nRespond ONLY with the JSON object, no other text.`;

    const messages = Array.isArray(body.messages) ? body.messages.map(m => ({ ...m })) : [];
    const sys = messages.find(m => m.role === "system");
    if (sys) {
      if (typeof sys.content === "string") sys.content = `${sys.content}\n\n${prompt}`;
      // messages.map(m => ({ ...m })) shallow-clones each message but the content
      // array is still the caller's reference — build a new array instead of
      // push() so we don't mutate (and duplicate on retry) the original body.
      else if (Array.isArray(sys.content)) sys.content = [...sys.content, { type: "text", text: `\n\n${prompt}` }];
    } else {
      messages.unshift({ role: "system", content: prompt });
    }
    return { ...body, messages, response_format: { type: "json_object" } };
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    if (this.provider?.startsWith?.("openai-compatible-")) {
      const baseUrl = credentials?.providerSpecificData?.baseUrl || "https://api.openai.com/v1";
      const normalized = validateProviderBaseUrl(baseUrl);
      const path = this.provider.includes("responses") ? "/responses" : "/chat/completions";
      return `${normalized}${path}`;
    }
    if (this.provider?.startsWith?.("anthropic-compatible-")) {
      const baseUrl = credentials?.providerSpecificData?.baseUrl || "https://api.anthropic.com/v1";
      const normalized = validateProviderBaseUrl(baseUrl);
      return `${normalized}/messages`;
    }
    switch (this.provider) {
      case "claude":
      case "glm":
      case "kimi":
      case "minimax":
      case "minimax-cn":
        return `${this.config.baseUrl}?beta=true`;
      case "kimi-coding":
        return `${this.config.baseUrl}?beta=true`;
      case "gemini":
        return `${this.config.baseUrl}/${model}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
      default: {
        if (this.provider === "xiaomi-tokenplan") {
          return `${resolveXiaomiTokenplanBaseUrl(credentials)}/chat/completions`;
        }
        const url = this.config.baseUrl;
        if (!url) {
          throw new Error(`Unknown provider "${this.provider}" has no configured base URL`);
        }
        if (url?.includes("{accountId}")) {
          const accountId = credentials?.providerSpecificData?.accountId;
          if (!accountId) throw new Error(`${this.provider} requires accountId in providerSpecificData`);
          return url.replace("{accountId}", accountId);
        }
        return url;
      }
    }
  }

  buildHeaders(credentials, stream = true) {
    const headers = { "Content-Type": "application/json", ...this.config.headers };

    switch (this.provider) {
      case "gemini":
        // Guard against `Authorization: Bearer undefined` when neither an API
        // key nor an access token is present — that produces an opaque 401
        // instead of surfacing the missing-credential condition.
        if (credentials.apiKey) {
          headers["x-goog-api-key"] = credentials.apiKey;
        } else if (credentials.accessToken) {
          headers["Authorization"] = `Bearer ${credentials.accessToken}`;
        }
        break;
      case "claude": {
        // Passthrough: forward client Anthropic identity headers as-is (OpenCode, SDK, etc.).
        // Native Claude CLI: overlay live cached headers over static defaults.
        const cached = credentials?._passthrough
          ? extractPassthroughAnthropicHeaders(credentials?._requestHeaders)
          : getCachedClaudeHeaders(credentials?.connectionId, credentials?._requestHeaders);
        if (cached) {
          // Remove Title-Case static keys that conflict with incoming lowercase cached keys
          for (const lcKey of Object.keys(cached)) {
            // Build the Title-Case equivalent: "anthropic-version" → "Anthropic-Version"
            const titleKey = lcKey.replace(/(^|-)([a-z])/g, (_, sep, c) => sep + c.toUpperCase());

            // Special handling for Anthropic-Beta to preserve required flags like OAuth
            if (
              lcKey === "anthropic-beta"
              && !credentials?._preserveClientCache
              && !credentials?._passthrough
            ) {
              const staticBetaStr = headers[titleKey] || headers[lcKey] || "";
              const staticFlags = new Set(staticBetaStr.split(",").map(f => f.trim()).filter(Boolean));
              const cachedFlags = new Set(cached[lcKey].split(",").map(f => f.trim()).filter(Boolean));

              for (const flag of staticFlags) {
                cachedFlags.add(flag);
              }

              cached[lcKey] = Array.from(cachedFlags).join(",");
            }

            if (titleKey !== lcKey && headers[titleKey] !== undefined) {
              delete headers[titleKey];
            }
          }
          Object.assign(headers, cached);
        }
        credentials.apiKey
          ? (headers["x-api-key"] = credentials.apiKey)
          : (headers["Authorization"] = `Bearer ${credentials.accessToken}`);
        break;
      }
      case "glm":
      case "kimi":
      case "minimax":
      case "minimax-cn":
      case "kimi-coding":
        headers["x-api-key"] = credentials.apiKey || credentials.accessToken;
        if (this.provider === "kimi-coding") Object.assign(headers, buildKimiHeaders());
        break;
      default:
        if (this.provider?.startsWith?.("anthropic-compatible-")) {
          if (credentials.apiKey) {
            headers["x-api-key"] = credentials.apiKey;
          } else if (credentials.accessToken) {
            headers["Authorization"] = `Bearer ${credentials.accessToken}`;
          }
          if (!headers["anthropic-version"]) {
            headers["anthropic-version"] = "2023-06-01";
          }
        } else if (this.provider === "gitlab") {
          // GitLab Duo uses Bearer token (PAT with ai_features scope, or OAuth access token)
          headers["Authorization"] = `Bearer ${credentials.apiKey || credentials.accessToken}`;
        } else if (this.provider === "codebuddy") {
          headers["Authorization"] = `Bearer ${credentials.apiKey || credentials.accessToken}`;
        } else if (this.provider === "kilocode") {
          headers["Authorization"] = `Bearer ${credentials.apiKey || credentials.accessToken}`;
          if (credentials.providerSpecificData?.orgId) {
            headers["X-Kilocode-OrganizationID"] = credentials.providerSpecificData.orgId;
          }
        } else if (this.provider === "cline") {
          Object.assign(headers, buildClineHeaders(credentials.apiKey || credentials.accessToken));
        } else if (this.config?.format === "claude") {
          // Generic claude-format provider (e.g. agentrouter): x-api-key + anthropic-version
          headers["x-api-key"] = credentials.apiKey || credentials.accessToken;
          if (!headers["anthropic-version"]) headers["anthropic-version"] = "2023-06-01";
        } else {
          headers["Authorization"] = `Bearer ${credentials.apiKey || credentials.accessToken}`;
        }
    }

    // Strip first-party Claude Code identity headers for non-Anthropic anthropic-compatible upstreams
    if (this.provider?.startsWith?.("anthropic-compatible-")) {
      const baseUrl = credentials?.providerSpecificData?.baseUrl || "";
      const isOfficialAnthropic = baseUrl === "" || baseUrl.includes("api.anthropic.com");
      if (!isOfficialAnthropic) {
        // Some third-party Anthropic-compatible gateways require Bearer auth in
        // addition to x-api-key. Send both (x-api-key already set above) so
        // gateways that read either header succeed.
        if (credentials.apiKey && !headers["Authorization"]) {
          headers["Authorization"] = `Bearer ${credentials.apiKey}`;
        }
        delete headers["anthropic-dangerous-direct-browser-access"];
        delete headers["Anthropic-Dangerous-Direct-Browser-Access"];
        delete headers["x-app"];
        delete headers["X-App"];
        // Strip claude-code-20250219 from Anthropic-Beta / anthropic-beta
        for (const betaKey of ["anthropic-beta", "Anthropic-Beta"]) {
          if (headers[betaKey]) {
            const filtered = headers[betaKey]
              .split(",")
              .map(s => s.trim())
              .filter(f => f && f !== "claude-code-20250219")
              .join(",");
            if (filtered) {
              headers[betaKey] = filtered;
            } else {
              delete headers[betaKey];
            }
          }
        }
      }
    }

    if (credentials?._passthrough && credentials?._requestHeaders?.accept) {
      headers["Accept"] = credentials._requestHeaders.accept;
    } else if (stream) {
      headers["Accept"] = "text/event-stream";
    }
    return headers;
  }

  async refreshCredentials(credentials, log, proxyOptions = null) {
    if (!credentials.refreshToken) return null;

    const refreshers = {
      claude: () => this.refreshWithJSON(OAUTH_ENDPOINTS.anthropic.token, { grant_type: "refresh_token", refresh_token: credentials.refreshToken, client_id: PROVIDERS.claude.clientId }, proxyOptions),
      codex: () => this.refreshWithForm(OAUTH_ENDPOINTS.openai.token, { grant_type: "refresh_token", refresh_token: credentials.refreshToken, client_id: PROVIDERS.codex.clientId, scope: "openid profile email offline_access" }, proxyOptions),
      qwen: () => this.refreshWithForm(OAUTH_ENDPOINTS.qwen.token, { grant_type: "refresh_token", refresh_token: credentials.refreshToken, client_id: PROVIDERS.qwen.clientId }, proxyOptions),
      iflow: () => this.refreshIflow(credentials.refreshToken, proxyOptions),
      gemini: () => this.refreshGoogle(credentials.refreshToken, proxyOptions),
      kiro: () => this.refreshKiro(credentials.refreshToken, proxyOptions),
      cline: () => this.refreshCline(credentials.refreshToken, proxyOptions),
      "kimi-coding": () => this.refreshKimiCoding(credentials.refreshToken, proxyOptions),
      kilocode: () => this.refreshKilocode(credentials.refreshToken, proxyOptions)
    };

    const refresher = refreshers[this.provider];
    if (!refresher) return null;

    try {
      const result = await refresher();
      if (result) log?.info?.("TOKEN", `${this.provider} refreshed`);
      return result;
    } catch (error) {
      log?.error?.("TOKEN", `${this.provider} refresh error: ${error.message}`);
      return null;
    }
  }

  async refreshWithJSON(url, body, proxyOptions = null) {
    const response = await proxyAwareFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(body)
    }, proxyOptions);
    if (!response.ok) return null;
    const tokens = await response.json();
    return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token || body.refresh_token, expiresIn: tokens.expires_in };
  }

  async refreshWithForm(url, params, proxyOptions = null) {
    const response = await proxyAwareFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
      body: new URLSearchParams(params)
    }, proxyOptions);
    if (!response.ok) return null;
    const tokens = await response.json();
    return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token || params.refresh_token, expiresIn: tokens.expires_in };
  }

  async refreshIflow(refreshToken, proxyOptions = null) {
    const basicAuth = btoa(`${PROVIDERS.iflow.clientId}:${PROVIDERS.iflow.clientSecret}`);
    const response = await proxyAwareFetch(OAUTH_ENDPOINTS.iflow.token, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json", "Authorization": `Basic ${basicAuth}` },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: PROVIDERS.iflow.clientId, client_secret: PROVIDERS.iflow.clientSecret })
    }, proxyOptions);
    if (!response.ok) return null;
    const tokens = await response.json();
    return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token || refreshToken, expiresIn: tokens.expires_in };
  }

  async refreshGoogle(refreshToken, proxyOptions = null) {
    const response = await proxyAwareFetch(OAUTH_ENDPOINTS.google.token, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: this.config.clientId, client_secret: this.config.clientSecret })
    }, proxyOptions);
    if (!response.ok) return null;
    const tokens = await response.json();
    return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token || refreshToken, expiresIn: tokens.expires_in };
  }

  async refreshKiro(refreshToken, proxyOptions = null) {
    const response = await proxyAwareFetch(PROVIDERS.kiro.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json", "User-Agent": "kiro-cli/1.0.0" },
      body: JSON.stringify({ refreshToken })
    }, proxyOptions);
    if (!response.ok) return null;
    const tokens = await response.json();
    return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken || refreshToken, expiresIn: tokens.expiresIn };
  }

  async refreshCline(refreshToken, proxyOptions = null) {
    const response = await proxyAwareFetch("https://api.cline.bot/api/v1/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ refreshToken, grantType: "refresh_token", clientType: "extension" })
    }, proxyOptions);
    if (!response.ok) return null;
    const payload = await response.json();
    const data = payload?.data || payload;
    const expiresAtIso = data?.expiresAt;
    const expiresIn = expiresAtIso ? Math.max(1, Math.floor((new Date(expiresAtIso).getTime() - Date.now()) / 1000)) : undefined;
    return { accessToken: data?.accessToken, refreshToken: data?.refreshToken || refreshToken, expiresIn };
  }

  async refreshKimiCoding(refreshToken, proxyOptions = null) {
    const kimiHeaders = buildKimiHeaders();
    const response = await proxyAwareFetch("https://auth.kimi.com/api/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
        ...kimiHeaders
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: "17e5f671-d194-4dfb-9706-5516cb48c098" })
    }, proxyOptions);
    if (!response.ok) return null;
    const tokens = await response.json();
    return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token || refreshToken, expiresIn: tokens.expires_in };
  }

  async refreshKilocode(refreshToken, proxyOptions = null) {
    // Kilocode uses device code flow, no refresh token support
    return null;
  }
}

export default DefaultExecutor;
