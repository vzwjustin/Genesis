import { ERROR_TYPES, DEFAULT_ERROR_MESSAGES, MIN_RETRY_DELAY_MS } from "../config/errorConfig.js";

/** Response header set by proxy-generated account-exhaustion responses. */
export const PROXY_EXHAUSTED_HEADER = "X-genesis-Account-Exhausted";

/**
 * Pre-dispatch validation error types for HTTP 400 responses.
 * Used when request-shape failures prevent successful request processing.
 */
export const VALIDATION_ERROR_TYPES = {
  TRANSLATION_INVALID_BODY: "translation_invalid_body",
  VALIDATION_FAILED: "validation_failed",
  UNSUPPORTED_REQUEST: "unsupported_request",
  MISSING_REQUIRED_FIELD: "missing_required_field",
};

/** Proxy-generated errors (SSE assembly, parse, compression restore) — not upstream provider faults. */
export const PROXY_INTERNAL_ERROR_CODES = {
  SSE_ASSEMBLY_FAILED: "sse_assembly_failed",
  RESPONSE_PARSE_FAILED: "response_parse_failed",
  COMPRESSION_RESTORE_FAILED: "compression_restore_failed",
  CACHE_INTEGRITY_FAILED: "cache_integrity_failed",
  PROXY_INTERNAL: "proxy_internal",
};

const PROXY_INTERNAL_CODE_SET = new Set(Object.values(PROXY_INTERNAL_ERROR_CODES));

/**
 * @param {{ proxyInternal?: boolean, errorCode?: string }} [meta]
 */
export function isProxyInternalError(meta = {}) {
  if (meta.proxyInternal === true) return true;
  if (!meta.errorCode) return false;
  return PROXY_INTERNAL_CODE_SET.has(meta.errorCode);
}

/**
 * Build OpenAI-compatible error response body
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @param {object} [options] - Optional overrides
 * @param {string} [options.errorType] - Custom error type (overrides status-based lookup)
 * @param {string} [options.errorCode] - Custom error code (overrides status-based lookup)
 * @returns {object} Error response object
 */
export function buildErrorBody(statusCode, message, options = {}) {
  const errorInfo = ERROR_TYPES[statusCode] || 
    (statusCode >= 500 
      ? { type: "server_error", code: "internal_server_error" }
      : { type: "invalid_request_error", code: "" });

  return {
    error: {
      message: message || DEFAULT_ERROR_MESSAGES[statusCode] || "An error occurred",
      type: options.errorType || errorInfo.type,
      code: options.errorCode || errorInfo.code
    }
  };
}

/**
 * Create error Response object (for non-streaming)
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @param {object} [options] - Optional overrides for error type/code
 * @param {string} [options.errorType] - Custom error type
 * @param {string} [options.errorCode] - Custom error code
 * @returns {Response} HTTP Response object
 */
export function errorResponse(statusCode, message, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };
  const resetsAtMs = options.resetsAtMs;
  if (resetsAtMs && statusCode === 429) {
    const minRetryDelaySec = Math.ceil(MIN_RETRY_DELAY_MS / 1000);
    const retryAfterSec = Math.max(
      minRetryDelaySec,
      Math.ceil((resetsAtMs - Date.now()) / 1000)
    );
    headers["Retry-After"] = String(retryAfterSec);
  }
  if (options.retryAfterSec != null) {
    headers["Retry-After"] = String(Math.max(1, Number(options.retryAfterSec) || 1));
  } else if (statusCode === 429) {
    headers["Retry-After"] = String(Math.ceil(MIN_RETRY_DELAY_MS / 1000));
  }
  return new Response(JSON.stringify(buildErrorBody(statusCode, message, options)), {
    status: statusCode,
    headers,
  });
}

/**
 * Create HTTP 400 error response for pre-dispatch validation failures.
 * @param {string} errorType - One of VALIDATION_ERROR_TYPES values
 * @param {string} message - Descriptive error message
 * @returns {Response} HTTP 400 Response object
 */
export function validationErrorResponse(errorType, message) {
  return errorResponse(400, message, { errorType, errorCode: errorType });
}

/**
 * Create HTTP 404 response for an inbound model string that resolves to no provider.
 * Fail closed: never guess the intended model.
 * @param {string} modelStr - The unresolved Provider_Model_String from the request
 * @param {string[]} [availableModelIds] - Registered model ids the client may use instead
 * @returns {Response} HTTP 404 Response object
 */
export function modelNotFoundResponse(modelStr, availableModelIds = []) {
  const message = `Model '${modelStr}' not found. See available_models for valid model ids.`;
  const body = buildErrorBody(404, message, { errorType: "model_not_found", errorCode: "model_not_found" });
  body.error.model = modelStr;
  body.error.available_models = Array.isArray(availableModelIds) ? availableModelIds : [];
  return new Response(JSON.stringify(body), {
    status: 404,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Create HTTP 503 response for a resolved provider that has zero configured connections.
 * Fail closed: zero connections means zero retries; do not attempt an upstream request.
 * @param {string} providerAlias - The provider alias with no active connections
 * @returns {Response} HTTP 503 Response object
 */
export function noConnectionsResponse(providerAlias) {
  const message = `Provider '${providerAlias}' has no active connections.`;
  const body = buildErrorBody(503, message, { errorType: "no_active_connections", errorCode: "no_active_connections" });
  body.error.provider = providerAlias;
  return new Response(JSON.stringify(body), {
    status: 503,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Write error to SSE stream (for streaming)
 * @param {WritableStreamDefaultWriter} writer - Stream writer
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 */
export async function writeStreamError(writer, statusCode, message) {
  const errorBody = buildErrorBody(statusCode, message);
  const encoder = new TextEncoder();
  await writer.write(encoder.encode(`data: ${JSON.stringify(errorBody)}\n\n`));
}

/**
 * Parse upstream provider error response
 * @param {Response} response - Fetch response from provider
 * @param {object} [executor] - Optional executor with parseError() override for provider-specific parsing
 * @returns {Promise<{statusCode: number, message: string, resetsAtMs?: number, errorCode?: string}>}
 */
function extractErrorCodeFromJson(json) {
  if (!json || typeof json !== "object") return undefined;
  const code = json.error?.code ?? json.code;
  return typeof code === "string" && code.length > 0 ? code : undefined;
}

export async function parseUpstreamError(response, executor = null) {
  let bodyText = "";
  try {
    bodyText = await response.text();
  } catch {
    bodyText = "";
  }

  // Let executor-specific parser extract provider-specific fields (e.g. codex resetsAtMs)
  if (executor && typeof executor.parseError === "function") {
    try {
      const parsed = executor.parseError(response, bodyText);
      if (typeof parsed === "string" && parsed) {
        return { statusCode: response.status, message: parsed };
      }
      if (parsed && typeof parsed === "object") {
        const msg = parsed.message || DEFAULT_ERROR_MESSAGES[response.status] || `Upstream error: ${response.status}`;
        const errorCode = parsed.code || parsed.errorCode;
        return {
          statusCode: parsed.status || response.status,
          message: msg,
          resetsAtMs: parsed.resetsAtMs,
          errorCode: typeof errorCode === "string" ? errorCode : undefined,
        };
      }
    } catch { /* fall through to default parsing */ }
  }

  let message = "";
  let errorCode;
  try {
    const json = JSON.parse(bodyText);
    message = json.error?.message || json.message || json.error || bodyText;
    errorCode = extractErrorCodeFromJson(json);
  } catch {
    message = bodyText;
  }

  const messageStr = typeof message === "string" ? message : JSON.stringify(message);
  const finalMessage = messageStr || DEFAULT_ERROR_MESSAGES[response.status] || `Upstream error: ${response.status}`;

  return { statusCode: response.status, message: finalMessage, errorCode };
}

/**
 * Create error result for chatCore handler
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @param {number} [resetsAtMs] - Optional precise cooldown expiry (ms epoch) for provider-specific quota errors
 * @param {object} [options] - Optional overrides for error type/code
 * @param {string} [options.errorType] - Custom error type
 * @param {string} [options.errorCode] - Custom error code
 * @param {boolean} [options.proxyInternal] - True when error is proxy-generated (not upstream)
 * @returns {{ success: false, status: number, error: string, response: Response, resetsAtMs?: number, errorCode?: string, proxyInternal?: boolean }}
 */
export function createErrorResult(statusCode, message, resetsAtMs, options = {}) {
  const proxyInternal = isProxyInternalError(options);
  return {
    success: false,
    status: statusCode,
    error: message,
    resetsAtMs,
    errorCode: options.errorCode,
    proxyInternal,
    response: errorResponse(statusCode, message, { ...options, resetsAtMs }),
  };
}

/**
 * Create unavailable response when all accounts are rate limited
 * @param {number} statusCode - Original error status code
 * @param {string} message - Error message (without retry info)
 * @param {string} retryAfter - ISO timestamp when earliest account becomes available
 * @param {string} retryAfterHuman - Human-readable retry info e.g. "reset after 30s"
 * @returns {Response}
 */
export function unavailableResponse(statusCode, message, retryAfter, retryAfterHuman) {
  const parsedDate = new Date(retryAfter).getTime();
  const minRetryDelaySec = Math.ceil(MIN_RETRY_DELAY_MS / 1000);
  // Enforce minimum retry delay: never return Retry-After: 0 for a no-capacity state
  const retryAfterSec = Number.isNaN(parsedDate) ? 60 : Math.max(minRetryDelaySec, Math.ceil((parsedDate - Date.now()) / 1000));
  const msg = `${message} (${retryAfterHuman})`;
  return new Response(
    JSON.stringify({ error: { message: msg } }),
    {
      status: statusCode,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(retryAfterSec),
        [PROXY_EXHAUSTED_HEADER]: "1",
        "Access-Control-Allow-Origin": "*"
      }
    }
  );
}

/**
 * Format provider error with context
 * @param {Error} error - Original error
 * @param {string} provider - Provider name
 * @param {string} model - Model name
 * @param {number|string} statusCode - HTTP status code or error code
 * @returns {string} Formatted error message
 */
export function formatProviderError(error, provider, model, statusCode) {
  const code = statusCode || error.code || "FETCH_FAILED";
  const message = error.message || "Unknown error";
  // Expose low-level cause (e.g. UND_ERR_SOCKET, ECONNRESET, ETIMEDOUT) for diagnosing fetch failures
  const causeCode = error.cause?.code;
  const causeMsg = error.cause?.message;
  const causeStr = causeCode || causeMsg ? ` (cause: ${[causeCode, causeMsg].filter(Boolean).join(": ")})` : "";
  return `[${code}]: ${message}${causeStr}`;
}
