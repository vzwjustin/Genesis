import { HTTP_STATUS, RETRY_CONFIG, DEFAULT_RETRY_CONFIG, resolveRetryEntry, FETCH_CONNECT_TIMEOUT_MS } from "../config/runtimeConfig.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { dbg } from "../utils/debugLog.js";
import { validateProviderBaseUrl } from "../utils/ssrfGuard.js";
import { throwOnCacheViolation } from "../rtk/cacheBoundary.js";
import { mergeAbortSignals } from "../utils/abortSignal.js";

/**
 * Normalize an expiry value to epoch milliseconds.
 * Accepts ISO strings, numeric ms, and numeric seconds (auto-detected: a
 * positive value below 1e12 is treated as seconds and scaled). Returns null
 * when the value cannot be parsed into a finite timestamp — callers should
 * treat null as "expiry unknown → refresh" rather than reusing a stale token.
 * @param {string|number} expiresAt
 * @returns {number|null}
 */
export function normalizeExpiryMs(expiresAt) {
  let ms;
  if (typeof expiresAt === "number") {
    ms = expiresAt > 0 && expiresAt < 1e12 ? expiresAt * 1000 : expiresAt;
  } else if (typeof expiresAt === "string") {
    const asNum = Number(expiresAt);
    if (Number.isFinite(asNum) && expiresAt.trim() !== "") {
      ms = asNum > 0 && asNum < 1e12 ? asNum * 1000 : asNum;
    } else {
      ms = new Date(expiresAt).getTime();
    }
  } else {
    return null;
  }
  return Number.isFinite(ms) ? ms : null;
}

/**
 * BaseExecutor - Base class for provider executors
 */
export class BaseExecutor {
  constructor(provider, config) {
    this.provider = provider;
    this.config = config;
    this.noAuth = config?.noAuth || false;
    this.supportsTokenRefresh = true;
  }

  getProvider() {
    return this.provider;
  }

  getBaseUrls() {
    return this.config.baseUrls || (this.config.baseUrl ? [this.config.baseUrl] : []);
  }

  getFallbackCount() {
    return this.getBaseUrls().length || 1;
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null, requestContext = {}) {
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
    const baseUrls = this.getBaseUrls();
    const baseUrl = baseUrls[urlIndex] || baseUrls[0] || this.config.baseUrl;
    if (
      this.provider === "openai" &&
      requestContext?.passthrough === true &&
      requestContext?.sourceFormat === "openai-responses"
    ) {
      return String(baseUrl).replace(/\/chat\/completions\/?$/, "/responses");
    }
    return baseUrl;
  }

  buildHeaders(credentials, stream = true) {
    const headers = {
      "Content-Type": "application/json",
      ...this.config.headers
    };

    if (this.provider?.startsWith?.("anthropic-compatible-")) {
      // Anthropic-compatible providers use x-api-key header
      if (credentials.apiKey) {
        headers["x-api-key"] = credentials.apiKey;
      } else if (credentials.accessToken) {
        headers["Authorization"] = `Bearer ${credentials.accessToken}`;
      }
      if (!headers["anthropic-version"]) {
        headers["anthropic-version"] = "2023-06-01";
      }
    } else {
      // Standard Bearer token auth for other providers
      if (credentials.accessToken) {
        headers["Authorization"] = `Bearer ${credentials.accessToken}`;
      } else if (credentials.apiKey) {
        headers["Authorization"] = `Bearer ${credentials.apiKey}`;
      }
    }

    if (stream) {
      headers["Accept"] = "text/event-stream";
    }

    return headers;
  }

  // Override in subclass for provider-specific transformations
  transformRequest(model, body, stream, credentials) {
    return body;
  }

  // Override in subclass to remove local proxy metadata from passthrough requests.
  transformPassthroughRequest(model, body, stream, credentials) {
    return body;
  }

  shouldRetry(status, urlIndex) {
    return status === HTTP_STATUS.RATE_LIMITED && urlIndex + 1 < this.getFallbackCount();
  }

  // Override in subclass for provider-specific refresh
  async refreshCredentials(credentials, log, proxyOptions = null) {
    return null;
  }

  needsRefresh(credentials) {
    // Distinguish "no expiry tracked" (null/undefined/"") from "expiry present
    // but unparseable". The former is a long-lived credential → no refresh; the
    // latter (NaN, bad string) is suspect → refresh rather than reuse a stale token.
    const raw = credentials.expiresAt;
    if (raw === null || raw === undefined || raw === "") return false;
    const expiresAtMs = normalizeExpiryMs(raw);
    if (expiresAtMs === null) return true;
    return expiresAtMs - Date.now() < 5 * 60 * 1000;
  }

  parseError(response, bodyText) {
    return { status: response.status, message: bodyText || `HTTP ${response.status}` };
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null, passthrough = false, cacheProtectedSnapshot = null, sourceFormat = null }) {
    const fallbackCount = this.getFallbackCount();
    let lastError = null;
    let lastStatus = 0;
    const retryAttemptsByUrl = {};

    // Merge default retry config with provider-specific config
    const retryConfig = { ...DEFAULT_RETRY_CONFIG, ...this.config.retry };

    // Schedule retry via retryConfig[statusKey]. Returns true when caller should `urlIndex--; continue`
    const tryRetry = async (urlIndex, statusKey, reason) => {
      const { attempts, delayMs } = resolveRetryEntry(retryConfig[statusKey]);
      if (attempts <= 0 || retryAttemptsByUrl[urlIndex] >= attempts) return false;
      retryAttemptsByUrl[urlIndex]++;
      log?.debug?.("RETRY", `${reason} retry ${retryAttemptsByUrl[urlIndex]}/${attempts} after ${delayMs / 1000}s`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
      return true;
    };

    for (let urlIndex = 0; urlIndex < fallbackCount; urlIndex++) {
      const url = this.buildUrl(model, stream, urlIndex, credentials, { body, passthrough, sourceFormat });
      // Passthrough (passthru) mode: skip normal translation; only strip local proxy metadata.
      const transformedBody = passthrough
        ? await Promise.resolve(this.transformPassthroughRequest(model, body, stream, credentials))
        : await Promise.resolve(this.transformRequest(model, body, stream, credentials));

      throwOnCacheViolation(transformedBody, cacheProtectedSnapshot, "executor transform");

      const headers = this.buildHeaders(credentials, stream);

      if (!retryAttemptsByUrl[urlIndex]) retryAttemptsByUrl[urlIndex] = 0;

      // Abort if upstream doesn't return response headers within FETCH_CONNECT_TIMEOUT_MS
      const connectCtrl = new AbortController();
      const connectTimer = setTimeout(() => connectCtrl.abort(new Error("fetch connect timeout")), FETCH_CONNECT_TIMEOUT_MS);
      const merged = signal
        ? mergeAbortSignals([signal, connectCtrl.signal])
        : { signal: connectCtrl.signal, cleanup: () => {} };
      const mergedSignal = merged.signal;

      try {
        const bodyStr = JSON.stringify(transformedBody);
        const fetchT0 = Date.now();
        dbg("FETCH", `${this.provider.toUpperCase()} → ${url} | body=${bodyStr.length}B | connectTimeout=${FETCH_CONNECT_TIMEOUT_MS}ms`);
        const response = await proxyAwareFetch(url, {
          method: "POST",
          headers,
          body: bodyStr,
          signal: mergedSignal
        }, proxyOptions);
        clearTimeout(connectTimer);
        merged.cleanup?.();
        const ct = response.headers?.get?.("content-type") || "";
        const cl = response.headers?.get?.("content-length") || "?";
        dbg("FETCH", `${this.provider.toUpperCase()} ← ${response.status} | ttft=${Date.now() - fetchT0}ms | ct=${ct} | cl=${cl}`);

        if (await tryRetry(urlIndex, response.status, `status ${response.status}`)) {
          // Drain the abandoned response body so undici frees the socket
          // instead of leaking it until stall-timeout/GC across retries.
          await response.body?.cancel?.().catch(() => {});
          urlIndex--;
          continue;
        }

        if (this.shouldRetry(response.status, urlIndex)) {
          log?.debug?.("RETRY", `${response.status} on ${url}, trying fallback ${urlIndex + 1}`);
          lastStatus = response.status;
          await response.body?.cancel?.().catch(() => {});
          continue;
        }

        return { response, url, headers, transformedBody };
      } catch (error) {
        clearTimeout(connectTimer);
        merged.cleanup?.();
        lastError = error;
        const isConnectTimeout = connectCtrl.signal.aborted && error.name === "AbortError";
        dbg("FETCH", `${this.provider.toUpperCase()} ✖ ${error.name}: ${error.message}${isConnectTimeout ? " (connect timeout)" : ""}`);
        // Connect timeout is internal — convert to retryable network error, don't propagate AbortError
        if (error.name === "AbortError" && !isConnectTimeout) throw error;

        // Map network/fetch exceptions to 502 retry config
        if (await tryRetry(urlIndex, HTTP_STATUS.BAD_GATEWAY, `network "${error.message}"`)) { urlIndex--; continue; }

        if (urlIndex + 1 < fallbackCount) {
          log?.debug?.("RETRY", `Error on ${url}, trying fallback ${urlIndex + 1}`);
          continue;
        }
        throw error;
      }
    }

    throw lastError || new Error(`All ${fallbackCount} URLs failed with status ${lastStatus}`);
  }
}

export default BaseExecutor;
