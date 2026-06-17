/**
 * Per-connection cache for real Claude Code client headers.
 * Captures headers from authentic Claude Code requests and makes them available
 * for forwarding to api.anthropic.com, replacing static hardcoded values.
 */

const CLAUDE_IDENTITY_HEADERS = [
  "user-agent",
  "anthropic-beta",
  "anthropic-version",
  "anthropic-dangerous-direct-browser-access",
  "x-app",
  "x-stainless-helper-method",
  "x-stainless-retry-count",
  "x-stainless-runtime-version",
  "x-stainless-package-version",
  "x-stainless-runtime",
  "x-stainless-lang",
  "x-stainless-arch",
  "x-stainless-os",
  "x-stainless-timeout",
  "x-claude-code-session-id",
  "package-version",
  "runtime-version",
  "os",
  "arch",
];

/** @type {Map<string, { headers: object, expiresAt: number }>} */
const cacheByConnection = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min — identity headers are short-lived
const CACHE_MAX_ENTRIES = 256;

// Reject values that could poison forwarded upstream headers: non-strings,
// header-injection payloads (CR/LF), or absurdly long values. Identity headers
// are small, single-line tokens.
function isSafeHeaderValue(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\r\n]/.test(value);
}

/**
 * Detect if request headers look like a real Claude Code client.
 * @param {object} headers - Lowercase header key/value object
 */
function isClaudeCodeClient(headers) {
  const ua = (headers["user-agent"] || "").toLowerCase();
  const xApp = (headers["x-app"] || "").toLowerCase();
  return ua.includes("claude-cli") || ua.includes("claude-code") || xApp === "cli";
}

function extractIdentityHeaders(headers) {
  const captured = {};
  for (const key of CLAUDE_IDENTITY_HEADERS) {
    const value = headers[key];
    if (value !== undefined && value !== null && isSafeHeaderValue(value)) {
      captured[key] = value;
    }
  }
  return Object.keys(captured).length > 0 ? captured : null;
}

/**
 * Extract Anthropic identity headers for passthrough forwarding.
 * Unlike cacheClaudeHeaders, does not require Claude Code user-agent — any client
 * sending anthropic-version/beta on /v1/messages should have headers forwarded as-is.
 * @param {object} headers - Lowercase header key/value object
 * @returns {object|null}
 */
export function extractPassthroughAnthropicHeaders(headers) {
  return extractIdentityHeaders(headers);
}

/**
 * Store Claude Code identity headers scoped to a connection.
 * @param {object} headers - Lowercase header key/value object
 * @param {string} [connectionId]
 */
export function cacheClaudeHeaders(headers, connectionId) {
  if (!headers || typeof headers !== "object" || !connectionId) return;
  if (!isClaudeCodeClient(headers)) return;

  const captured = extractIdentityHeaders(headers);
  if (captured) {
    // LRU: refresh recency on re-set; evict oldest when over the size cap.
    cacheByConnection.delete(connectionId);
    cacheByConnection.set(connectionId, { headers: captured, expiresAt: Date.now() + CACHE_TTL_MS });
    if (cacheByConnection.size > CACHE_MAX_ENTRIES) {
      const oldest = cacheByConnection.keys().next().value;
      if (oldest !== undefined) cacheByConnection.delete(oldest);
    }
    console.log(`[ClaudeHeaders] Cached ${Object.keys(captured).length} identity headers for connection ${connectionId}`);
  }
}

/**
 * Get Claude Code identity headers for a connection, or per-request fallback.
 * Without connectionId, returns headers extracted from the current request only.
 * @param {string} [connectionId]
 * @param {object} [requestHeaders] - Lowercase header key/value object from current request
 * @returns {object|null}
 */
export function getCachedClaudeHeaders(connectionId, requestHeaders) {
  let merged = null;

  if (connectionId && cacheByConnection.has(connectionId)) {
    const entry = cacheByConnection.get(connectionId);
    if (entry.expiresAt <= Date.now()) {
      cacheByConnection.delete(connectionId);
    } else {
      // Refresh recency (LRU) and read the cached headers.
      cacheByConnection.delete(connectionId);
      cacheByConnection.set(connectionId, entry);
      merged = { ...entry.headers };
    }
  }

  // Per-request headers win over the connection cache so volatile identity fields
  // (especially x-claude-code-session-id) stay aligned with the live client session.
  if (requestHeaders && isClaudeCodeClient(requestHeaders)) {
    const fromRequest = extractIdentityHeaders(requestHeaders);
    if (fromRequest) {
      merged = { ...merged, ...fromRequest };
    }
  }

  return merged && Object.keys(merged).length > 0 ? merged : null;
}

/** @internal test helper */
export function __clearClaudeHeaderCacheForTests() {
  cacheByConnection.clear();
}
