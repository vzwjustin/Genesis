import { Buffer } from "node:buffer";
import { createErrorResult, parseUpstreamError, formatProviderError, PROXY_INTERNAL_ERROR_CODES } from "../utils/error.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import { refreshWithRetry, isUnrecoverableRefreshError } from "../services/tokenRefresh.js";
import { getExecutor } from "../executors/index.js";
import { getImageAdapter } from "./imageProviders/index.js";
import { urlToBase64 } from "./imageProviders/_base.js";
import { proxyAwareFetch, buildProxyOptionsFromCredentials } from "../utils/proxyFetch.js";

function serializeRequestBody(requestBody) {
  if (typeof FormData !== "undefined" && requestBody instanceof FormData) return requestBody;
  if (typeof requestBody === "string") return requestBody;
  return JSON.stringify(requestBody);
}

/**
 * Core image generation handler — orchestrator only.
 * Provider-specific URL/headers/body/parse/normalize live in `./imageProviders/{id}.js`.
 *
 * @param {object} options
 * @param {object} options.body - Request body { model, prompt, n, size, ... }
 * @param {object} options.modelInfo - { provider, model }
 * @param {object} options.credentials - Provider credentials
 * @param {object} [options.log] - Logger
 * @param {boolean} [options.streamToClient] - Pipe SSE to client (codex)
 * @param {boolean} [options.binaryOutput] - Return raw image bytes
 * @param {function} [options.onCredentialsRefreshed]
 * @param {function} [options.onRequestSuccess]
 * @returns {Promise<{ success: boolean, response: Response, status?: number, error?: string }>}
 */
export async function handleImageGenerationCore({
  body,
  modelInfo,
  credentials,
  log,
  signal,
  streamToClient = false,
  binaryOutput = false,
  onCredentialsRefreshed,
  onRequestSuccess,
}) {
  const { provider, model } = modelInfo;

  if (signal?.aborted) {
    return createErrorResult(499, "Request aborted");
  }

  if (!body.prompt) {
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, "Missing required field: prompt");
  }

  const adapter = getImageAdapter(provider);
  if (!adapter) {
    return createErrorResult(
      HTTP_STATUS.BAD_REQUEST,
      `Provider '${provider}' does not support image generation`
    );
  }

  let url;
  let headers;
  let requestBody;

  try {
    url = adapter.buildUrl(model, credentials);
    requestBody = await adapter.buildBody(model, body);
    headers = adapter.buildHeaders(credentials, requestBody, model, body);
  } catch (error) {
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, error.message || `Invalid ${provider} image request`);
  }

  log?.debug?.("IMAGE", `${provider.toUpperCase()} | ${model} | prompt="${body.prompt.slice(0, 50)}..."`);

  const proxyOptions = buildProxyOptionsFromCredentials(credentials);
  let providerResponse;
  try {
    providerResponse = await proxyAwareFetch(url, {
      method: "POST",
      headers,
      body: serializeRequestBody(requestBody),
      signal,
    }, proxyOptions);
  } catch (error) {
    if (error.name === "AbortError" || signal?.aborted) {
      return createErrorResult(499, "Request aborted");
    }
    const errMsg = formatProviderError(error, provider, model, HTTP_STATUS.BAD_GATEWAY);
    log?.debug?.("IMAGE", `Fetch error: ${errMsg}`);
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, errMsg);
  }

  // Handle 401/403 — try token refresh (skipped for noAuth / non-refreshable providers)
  const executor = getExecutor(provider);
  if (
    !executor?.noAuth &&
    !adapter.noAuth &&
    (providerResponse.status === HTTP_STATUS.UNAUTHORIZED ||
      providerResponse.status === HTTP_STATUS.FORBIDDEN)
  ) {
    if (executor.supportsTokenRefresh === false) {
      const { statusCode, message } = await parseUpstreamError(providerResponse, executor);
      const errMsg = formatProviderError(new Error(message), provider, model, statusCode);
      return createErrorResult(statusCode, errMsg);
    }
    const newCredentials = await refreshWithRetry(
      () => executor.refreshCredentials(credentials, log, proxyOptions),
      3,
      log
    );

    if (isUnrecoverableRefreshError(newCredentials)) {
      log?.warn?.("TOKEN", `${provider.toUpperCase()} | unrecoverable refresh (${newCredentials.error})`);
      return createErrorResult(
        HTTP_STATUS.UNAUTHORIZED,
        "Authentication failed: token refresh rejected. Re-authenticate this connection.",
        undefined,
        { errorCode: newCredentials.error, proxyInternal: true }
      );
    }

    if (newCredentials?.accessToken || newCredentials?.copilotToken || newCredentials?.apiKey) {
      log?.info?.("TOKEN", `${provider.toUpperCase()} | refreshed for image generation`);
      Object.assign(credentials, newCredentials);
      if (onCredentialsRefreshed) await onCredentialsRefreshed(newCredentials);

      try {
        const retryBody = await adapter.buildBody(model, body);
        const retryHeaders = adapter.buildHeaders(credentials, retryBody, model, body);
        const retryUrl = adapter.buildUrl(model, credentials);
        providerResponse = await proxyAwareFetch(retryUrl, {
          method: "POST",
          headers: retryHeaders,
          body: serializeRequestBody(retryBody),
          signal,
        }, proxyOptions);
      } catch (retryError) {
        if (retryError.name === "AbortError" || signal?.aborted) {
          return createErrorResult(499, "Request aborted");
        }
        log?.warn?.("TOKEN", `${provider.toUpperCase()} | retry after refresh failed`);
        const errMsg = formatProviderError(retryError, provider, model, HTTP_STATUS.BAD_GATEWAY);
        return createErrorResult(HTTP_STATUS.BAD_GATEWAY, errMsg);
      }
    } else {
      log?.warn?.("TOKEN", `${provider.toUpperCase()} | refresh failed`);
      const { statusCode, message } = await parseUpstreamError(providerResponse, executor);
      const errMsg = formatProviderError(new Error(message), provider, model, statusCode);
      return createErrorResult(statusCode, errMsg);
    }
  }

  if (!providerResponse.ok) {
    const { statusCode, message } = await parseUpstreamError(providerResponse, executor);
    const errMsg = formatProviderError(new Error(message), provider, model, statusCode);
    log?.debug?.("IMAGE", `Provider error: ${errMsg}`);
    return createErrorResult(statusCode, errMsg);
  }

  // Parse provider response — adapter may override (codex SSE / async polling / binary)
  let parsed;
  try {
    if (adapter.parseResponse) {
      parsed = await adapter.parseResponse(providerResponse, {
        headers,
        log,
        streamToClient,
        onRequestSuccess,
        url,
        requestBody,
        model,
        body,
        proxyOptions,
      });
      // Codex streaming case: returns an SSE Response directly
      if (parsed?.sseResponse) {
        return { success: true, response: parsed.sseResponse };
      }
    } else {
      parsed = await providerResponse.json();
    }
  } catch (parseError) {
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, parseError.message || `Invalid response from ${provider}`, undefined, {
      errorCode: PROXY_INTERNAL_ERROR_CODES.RESPONSE_PARSE_FAILED,
      proxyInternal: true,
    });
  }

  if (onRequestSuccess) await onRequestSuccess();

  // Normalize → OpenAI-compatible shape
  const normalized = adapter.normalize(parsed, body.prompt);

  // Already in OpenAI shape? skip re-normalize
  const finalBody = (normalized.created && Array.isArray(normalized.data)) ? normalized : parsed;

  // Binary output: decode first b64_json (or fetch url) into raw bytes
  if (binaryOutput) {
    const first = finalBody.data?.[0];
    let b64 = first?.b64_json;
    if (!b64 && first?.url) {
      try {
        b64 = await urlToBase64(first.url, proxyOptions);
      } catch (fetchError) {
        const errMsg = fetchError?.message || "Failed to fetch image from URL";
        log?.debug?.("IMAGE", `URL fetch error: ${errMsg}`);
        return createErrorResult(HTTP_STATUS.BAD_GATEWAY, errMsg);
      }
    }
    if (b64) {
      const buf = Buffer.from(b64, "base64");
      const fmt = (body.output_format || "png").toLowerCase();
      const mime = fmt === "jpeg" || fmt === "jpg" ? "image/jpeg" : fmt === "webp" ? "image/webp" : "image/png";
      return {
        success: true,
        response: new Response(buf, {
          headers: {
            "Content-Type": mime,
            "Content-Disposition": `inline; filename="image.${fmt === "jpeg" ? "jpg" : fmt}"`,
            "Access-Control-Allow-Origin": "*",
          },
        }),
      };
    }
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, "Binary output requested but no image data in response");
  }

  return {
    success: true,
    response: new Response(JSON.stringify(finalBody), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    }),
  };
}
