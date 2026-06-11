// Shared redaction policy — single source of truth for "what is a secret".
// Imported by both the file request logger (open-sse/utils/requestLogger.js)
// and the DB observability repo (src/lib/db/repos/requestDetailsRepo.js) so the
// two redaction paths can never drift. Pure string/object logic — NO node:
// imports, safe in any runtime.

// Header/field names whose VALUES must never be persisted.
export const SENSITIVE_KEY_PARTS = [
  "authorization",
  "x-api-key",
  "cookie",
  "set-cookie",
  "token",
  "api-key",
  "api_key",
  "secret",
  "password",
];

const SENSITIVE_COMPACT_KEYS = [
  "apikey",
  "xapikey",
  "setcookie",
  "clientsecret",
  "accesstoken",
  "refreshtoken",
  "idtoken",
];

/**
 * True when a key name denotes a secret whose value must be DROPPED from
 * persisted structured data. Uses suffix/exact matching to avoid over-dropping
 * benign keys that merely contain a substring (e.g. "tokens", "tokenCount").
 */
export function isSensitiveKey(key) {
  const lower = String(key || "").toLowerCase();
  const compact = lower.replace(/[^a-z0-9]/g, "");
  return SENSITIVE_KEY_PARTS.includes(lower)
    || SENSITIVE_COMPACT_KEYS.includes(compact)
    || lower.endsWith("authorization")
    || lower.endsWith("cookie")
    || (lower.endsWith("token") && !lower.endsWith("tokens"))
    || lower.endsWith("secret")
    || lower.endsWith("password");
}

/**
 * True when a header NAME should have its value masked. Broader (substring)
 * than isSensitiveKey: masking only partially reveals a value, so a false
 * positive is harmless, and we want to catch vendor-prefixed variants like
 * "x-goog-api-key" or "proxy-authorization".
 */
export function isSensitiveHeaderName(key) {
  if (isSensitiveKey(key)) return true;
  const lower = String(key || "").toLowerCase();
  return SENSITIVE_KEY_PARTS.some((part) => lower.includes(part));
}

/** Redact secret-looking substrings from a free-text blob (logs, bodies, stack traces). */
export function redactSensitiveText(value) {
  return String(value)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "sk-[redacted]")
    .replace(/\b(access_token|refresh_token|id_token|api_key|client_secret|password|token|secret)=([^&\s]+)/gi, "$1=[redacted]")
    .replace(/("(?:authorization|x-api-key|cookie|set-cookie|access_token|refresh_token|id_token|api_key|client_secret|password|token|secret)"\s*:\s*")([^"\\]*(?:\\.[^"\\]*)*)"/gi, '$1[redacted]"')
    .replace(/('(?:authorization|x-api-key|cookie|set-cookie|access_token|refresh_token|id_token|api_key|client_secret|password|token|secret)'\s*:\s*')([^'\\]*(?:\\.[^'\\]*)*)'/gi, "$1[redacted]'")
    .replace(/\b(authorization|x-api-key|cookie|set-cookie)\s*:\s*([^\r\n]+)/gi, "$1: [redacted]");
}

/**
 * Recursively drop sensitive keys and redact string values from a structured object.
 * Sensitive keys are removed entirely (stronger than masking).
 */
export function sanitizeValue(value) {
  if (value == null) return value;
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item));
  if (typeof value !== "object") return value;

  const sanitized = {};
  for (const [key, item] of Object.entries(value)) {
    if (isSensitiveKey(key)) continue;
    sanitized[key] = sanitizeValue(item);
  }
  return sanitized;
}

function maskHeaderValue(value) {
  // Coerce non-string values (e.g. set-cookie arrives as a string[] in some runtimes)
  // to a string before length/slice — prevents leaking individual array elements.
  const str = Array.isArray(value) ? value.join(", ") : String(value ?? "");
  if (!str) return "[redacted]";
  return str.length > 20 ? `${str.slice(0, 4)}...${str.slice(-4)}` : "[redacted]";
}

/**
 * Mask (partially reveal) sensitive header values while preserving the header keys —
 * used where header presence is diagnostically useful but the value is secret.
 */
export function maskSensitiveHeaders(headers) {
  if (!headers || typeof headers !== "object") return {};
  const masked = { ...headers };
  for (const key of Object.keys(masked)) {
    if (isSensitiveHeaderName(key)) {
      const value = masked[key];
      if (value != null && value !== "") masked[key] = maskHeaderValue(value);
    }
  }
  return masked;
}
