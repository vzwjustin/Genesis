// Shared redaction policy — single source of truth for "what is a secret".
// Imported by both the file request logger (open-sse/utils/requestLogger.js)
// and the DB observability repo (src/lib/db/repos/requestDetailsRepo.js) so the
// two redaction paths can never drift. Pure string/object logic — NO node:
// imports, safe in any runtime.

// Header/field names whose VALUES must never be persisted.
export const SENSITIVE_KEY_PARTS = [
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "x-goog-api-key",
  "x-key",
  "x-relay-auth",
  "x-9r-cli-token",
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
  "xgoogapikey",
  "xkey",
  "xrelayauth",
  "proxyauthorization",
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

/** Query-param names whose values must be redacted in URLs (exact / compact match). */
const SENSITIVE_QUERY_PARAM_NAMES = new Set([
  "key",
  "api_key",
  "apikey",
  "access_token",
  "refresh_token",
  "id_token",
  "client_secret",
  "password",
  "token",
  "secret",
  "code",
  "auth",
  "session",
  "jwt",
  "signature",
]);

export function isSensitiveQueryParam(name) {
  const lower = String(name || "").toLowerCase();
  const compact = lower.replace(/[^a-z0-9]/g, "");
  return SENSITIVE_QUERY_PARAM_NAMES.has(lower)
    || SENSITIVE_QUERY_PARAM_NAMES.has(compact)
    || isSensitiveKey(name);
}

/** Redact secret-looking query params and free-text secrets from a URL string. */
export function redactSensitiveUrl(url) {
  if (url == null || typeof url !== "string" || !url) return url;
  let redacted = url;
  try {
    const parsed = new URL(url);
    for (const name of [...parsed.searchParams.keys()]) {
      if (isSensitiveQueryParam(name)) {
        parsed.searchParams.set(name, "[redacted]");
      }
    }
    redacted = parsed.toString();
  } catch {
    // relative or malformed URL — fall through to text redaction
  }
  return redactSensitiveText(redacted);
}

/** Redact secret-looking substrings from a free-text blob (logs, bodies, stack traces). */
export function redactSensitiveText(value) {
  return String(value)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/Api-?Key\s+[A-Za-z0-9._~+/=-]+/gi, "ApiKey [redacted]")
    .replace(/Token\s+[A-Za-z0-9._~+/=-]+/gi, "Token [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "sk-[redacted]")
    .replace(/\bsk_[A-Za-z0-9_-]+/g, "sk_[redacted]")
    .replace(/\bAIza[0-9A-Za-z_-]{10,}/g, "AIza[redacted]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]+/g, "gh[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "eyJ[redacted]")
    .replace(/\b(access_token|refresh_token|id_token|api_key|api-key|x-goog-api-key|x-key|x-relay-auth|client_secret|password|token|secret|key)=([^&\s]+)/gi, "$1=[redacted]")
    .replace(/("(?:authorization|proxy-authorization|x-api-key|x-goog-api-key|api-key|x-key|x-relay-auth|x-9r-cli-token|cookie|set-cookie|access_token|refresh_token|id_token|api_key|client_secret|password|token|secret)"\s*:\s*")([^"\\]*(?:\\.[^"\\]*)*)"/gi, '$1[redacted]"')
    .replace(/('(?:authorization|proxy-authorization|x-api-key|x-goog-api-key|api-key|x-key|x-relay-auth|x-9r-cli-token|cookie|set-cookie|access_token|refresh_token|id_token|api_key|client_secret|password|token|secret)'\s*:\s*')([^'\\]*(?:\\.[^'\\]*)*)'/gi, "$1[redacted]'")
    .replace(/\b(authorization|proxy-authorization|x-api-key|x-goog-api-key|api-key|x-key|x-relay-auth|x-9r-cli-token|cookie|set-cookie)\s*:\s*([^\r\n]+)/gi, "$1: [redacted]");
}

/**
 * Recursively drop sensitive keys and redact string values from a structured object.
 * Sensitive keys are removed entirely (stronger than masking).
 */
export function sanitizeValue(value, seen = new WeakSet(), depth = 0) {
  if (value == null) return value;
  if (typeof value === "string") return redactSensitiveText(value);
  if (typeof value !== "object") return value;

  // Guard against cycles and pathological nesting depth. Redaction is an
  // optional logging side-effect and must NEVER throw (e.g. a stack-overflow
  // RangeError) into the request path — fail open with a marker instead.
  // NOTE: entries are intentionally NEVER removed from `seen` (no per-subtree
  // delete). This visits each distinct object at most once → O(distinct nodes),
  // which resists a hostile "diamond" DAG that would otherwise expand to 2^depth
  // paths. The only cost is that a legitimately shared (non-cyclic) reference is
  // rendered as "[circular]" in the LOG copy — harmless, the real body is untouched.
  if (seen.has(value)) return Array.isArray(value) ? ["[circular]"] : "[circular]";
  if (depth > 200) return Array.isArray(value) ? ["[max-depth]"] : "[max-depth]";
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, seen, depth + 1));

  const sanitized = {};
  for (const [key, item] of Object.entries(value)) {
    if (isSensitiveKey(key)) continue;
    sanitized[key] = sanitizeValue(item, seen, depth + 1);
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
