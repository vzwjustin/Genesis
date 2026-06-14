import crypto from "crypto";
import { getApiKeySecret, LEGACY_API_KEY_SECRET } from "./apiKeySecret.js";

/**
 * Generate 6-char random keyId
 */
function generateKeyId() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.randomBytes(6);
  let result = "";
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(bytes[i] % chars.length);
  }
  return result;
}

function crcForSecret(machineId, keyId, secret) {
  return crypto
    .createHmac("sha256", secret)
    .update(machineId + keyId)
    .digest("hex")
    .slice(0, 8);
}

/** Generate CRC (8-char HMAC) using the current install secret. */
function generateCrc(machineId, keyId) {
  return crcForSecret(machineId, keyId, getApiKeySecret());
}

/** Constant-time equality for the CRC MAC — avoids a char-by-char timing oracle. */
function timingSafeCrcEqual(expected, actual) {
  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(actual));
  if (a.length !== b.length) return false; // crc is fixed-length hex; length mismatch can't match
  return crypto.timingSafeEqual(a, b);
}

/** Accept keys signed with the current or legacy default secret. */
function verifyCrc(machineId, keyId, crc) {
  const secrets = [getApiKeySecret()];
  if (!secrets.includes(LEGACY_API_KEY_SECRET)) secrets.push(LEGACY_API_KEY_SECRET);
  let ok = false;
  // No early return — check all secrets so timing doesn't reveal which matched.
  for (const secret of secrets) {
    if (timingSafeCrcEqual(crcForSecret(machineId, keyId, secret), crc)) ok = true;
  }
  return ok;
}

/**
 * Generate API key with machineId embedded
 * Format: sk-{machineId}-{keyId}-{crc8}
 * @param {string} machineId - 16-char machine ID
 * @returns {{ key: string, keyId: string }}
 */
export function generateApiKeyWithMachine(machineId) {
  const keyId = generateKeyId();
  const crc = generateCrc(machineId, keyId);
  const key = `sk-${machineId}-${keyId}-${crc}`;
  return { key, keyId };
}

/**
 * Parse API key and extract machineId + keyId
 * Supports both formats:
 * - New: sk-{machineId}-{keyId}-{crc8}
 * - Old: sk-{random8}
 * @param {string} apiKey
 * @returns {{ machineId: string, keyId: string, isNewFormat: boolean } | null}
 */
export function parseApiKey(apiKey) {
  if (!apiKey || !apiKey.startsWith("sk-")) return null;

  const parts = apiKey.split("-");
  
  // New format: sk-{machineId}-{keyId}-{crc8} = 4 parts
  if (parts.length === 4) {
    const [, machineId, keyId, crc] = parts;
    
    if (!verifyCrc(machineId, keyId, crc)) return null;
    
    return { machineId, keyId, isNewFormat: true };
  }
  
  // Old format: sk-{random8} = 2 parts
  if (parts.length === 2) {
    return { machineId: null, keyId: parts[1], isNewFormat: false };
  }
  
  return null;
}

/**
 * Verify API key CRC (only for new format)
 * @param {string} apiKey
 * @returns {boolean}
 */
export function verifyApiKeyCrc(apiKey) {
  const parsed = parseApiKey(apiKey);
  if (!parsed) return false;
  
  // Legacy sk-{8} format is no longer accepted — migrate to sk-{machineId}-{keyId}-{crc}
  if (!parsed.isNewFormat) return false;
  
  // New format already verified in parseApiKey
  return true;
}

/**
 * Check if API key is new format (contains machineId)
 * @param {string} apiKey
 * @returns {boolean}
 */
export function isNewFormatKey(apiKey) {
  const parsed = parseApiKey(apiKey);
  return parsed?.isNewFormat === true;
}

/** Localhost-only sentinel used by CLI tools when no real key is configured. */
export const LOCALHOST_SENTINEL_API_KEY = "sk_genesis";

export function isLocalhostSentinelKey(apiKey) {
  return apiKey === LOCALHOST_SENTINEL_API_KEY;
}

const PROVIDER_API_KEY_PREFIXES = [
  "sk-ant-",
  "sk-proj-",
  "sk-or-",
  "sk-svcacct-",
  "sk-admin-",
];

function isProviderApiKeyPrefix(token) {
  return PROVIDER_API_KEY_PREFIXES.some((prefix) => token.startsWith(prefix));
}

/** Max segment length for legacy sk-{keyId} gateway keys (provider sk- secrets are much longer). */
const LEGACY_GATEWAY_KEY_ID_MAX_LEN = 16;

/** machineId from getConsistentMachineId (8–16 hex); keyId from generateKeyId (6 alphanumeric). */
function isNewFormatGatewayKeyShape(parts) {
  if (parts.length !== 4) return false;
  const [, machineId, keyId, crc] = parts;
  return /^[0-9a-f]{8,16}$/i.test(machineId)
    && /^[a-z0-9]{6}$/i.test(keyId)
    && /^[0-9a-f]{8}$/i.test(crc);
}

/** sk-{machineId}-{keyId}-{crc8} or legacy sk-{id} — gateway-managed keys only. */
export function isgenesisKeyShape(token) {
  if (!token || typeof token !== "string" || !token.startsWith("sk-")) return false;
  if (isProviderApiKeyPrefix(token)) return false;
  const parts = token.split("-");
  if (isNewFormatGatewayKeyShape(parts)) return true;
  if (parts.length === 2) {
    const keyId = parts[1];
    return keyId.length >= 4 && keyId.length <= LEGACY_GATEWAY_KEY_ID_MAX_LEN;
  }
  return false;
}

function extractBearerToken(authHeader) {
  if (!authHeader || typeof authHeader !== "string") return null;
  const trimmed = authHeader.trim();
  const match = trimmed.match(/^Bearer\s+/i);
  if (!match) return null;
  const token = trimmed.slice(match[0].length).trim();
  return token || null;
}

/** Bearer, ApiKey/Api-Key, or raw sk-/sk_ credential from Authorization. */
function extractAuthorizationCredentialToken(request) {
  const auth = request.headers.get("Authorization")?.trim();
  if (!auth) return null;
  const bearer = extractBearerToken(auth);
  if (bearer) return bearer;
  const apiKeyMatch = auth.match(/^Api-?Key\s+(.+)$/i);
  if (apiKeyMatch) {
    const token = apiKeyMatch[1]?.trim();
    if (token) return token;
  }
  const tokenSchemeMatch = auth.match(/^Token\s+(.+)$/i);
  if (tokenSchemeMatch) {
    const token = tokenSchemeMatch[1]?.trim();
    if (token) return token;
  }
  if (/^sk[-_]/i.test(auth)) return auth;
  return null;
}

/** Gateway token from Authorization (Bearer or raw sk-…). */
function extractAuthorizationGatewayToken(request) {
  const token = extractAuthorizationCredentialToken(request);
  if (!token || !looksLikegenesisApiKey(token)) return null;
  return token;
}

function isVerifiableGatewayToken(token) {
  if (!token || !looksLikegenesisApiKey(token)) return false;
  if (isLocalhostSentinelKey(token)) return true;
  return verifyApiKeyCrc(token);
}

/** True when Authorization carries a non-gateway credential (OAuth JWT, provider sk-, etc.). */
export function hasNonGatewayBearer(request) {
  const token = extractAuthorizationCredentialToken(request);
  return !!token && !looksLikegenesisApiKey(token);
}

/** Vendor-specific API key headers (non-gateway credential signals for stale-gateway bypass). */
export const PROVIDER_API_KEY_HEADER_NAMES = ["api-key", "x-goog-api-key", "xi-api-key"];

/** True when a provider credential is present in x-api-key or vendor-specific headers. */
export function hasProviderApiKeyHeader(request) {
  const xApiKey = request.headers.get("x-api-key")?.trim();
  if (xApiKey) {
    if (isProviderApiKeyPrefix(xApiKey)) return true;
    if (!looksLikegenesisApiKey(xApiKey)) return true;
  }
  for (const name of PROVIDER_API_KEY_HEADER_NAMES) {
    if (request.headers.get(name)?.trim()) return true;
  }
  const authToken = extractAuthorizationCredentialToken(request);
  return !!authToken && isProviderApiKeyPrefix(authToken);
}

/** Loopback may ignore stale gateway headers when a provider credential is also present. */
export function allowsStaleGatewayBypass(request) {
  if (hasProviderApiKeyHeader(request)) return true;
  const token = extractAuthorizationCredentialToken(request);
  if (!token || looksLikegenesisApiKey(token)) return false;
  const auth = request.headers.get("Authorization")?.trim() || "";
  if (/^Bearer\s+/i.test(auth)) {
    if (token.includes(".")) return true;
    if (isProviderApiKeyPrefix(token)) return true;
    if (/^AIza[A-Za-z0-9_-]{20,}/.test(token)) return true;
    return false;
  }
  if (/^Token\s+/i.test(auth)) {
    return isProviderApiKeyPrefix(token) || token.includes(".") || token.length >= 8;
  }
  if (/^Api-?Key\s+/i.test(auth) && isProviderApiKeyPrefix(token)) return true;
  return false;
}

/** Ordered gateway credential candidates (x-api-key before Authorization; verifiable before stale). */
export function getGatewayApiKeyCandidates(request) {
  const xApiKey = request.headers.get("x-api-key")?.trim();
  const authToken = extractAuthorizationGatewayToken(request);
  const verifiable = [];
  const stale = [];

  for (const token of [xApiKey, authToken].filter(Boolean)) {
    if (!looksLikegenesisApiKey(token)) continue;
    if (isVerifiableGatewayToken(token)) {
      if (!verifiable.includes(token)) verifiable.push(token);
    } else if (!allowsStaleGatewayBypass(request) && !stale.includes(token)) {
      stale.push(token);
    }
  }

  return [...verifiable, ...stale];
}

/** Prefer verifiable gateway credentials (x-api-key wins when both are valid). */
export function extractGatewayApiKey(request) {
  const xApiKey = request.headers.get("x-api-key")?.trim();
  const authToken = extractAuthorizationGatewayToken(request);

  for (const token of [xApiKey, authToken].filter(Boolean)) {
    if (looksLikegenesisApiKey(token) && isVerifiableGatewayToken(token)) {
      return token;
    }
  }

  if (xApiKey && looksLikegenesisApiKey(xApiKey) && !allowsStaleGatewayBypass(request)) {
    return xApiKey;
  }
  if (authToken && looksLikegenesisApiKey(authToken) && !allowsStaleGatewayBypass(request)) {
    return authToken;
  }

  return null;
}

/** Extract Authorization credential (Bearer/ApiKey/raw sk-) before x-api-key. */
export function extractApiKey(request) {
  const authToken = extractAuthorizationCredentialToken(request);
  if (authToken) return authToken;
  return request.headers.get("x-api-key")?.trim() || null;
}

/**
 * True when a header value is intended as genesis gateway auth (not provider OAuth/JWT).
 * OAuth/JWT and provider keys (sk-ant-*, sk-proj-*, etc.) are ignored for gateway auth.
 */
export function looksLikegenesisApiKey(token) {
  if (!token || typeof token !== "string") return false;
  const trimmed = token.trim();
  if (isLocalhostSentinelKey(trimmed)) return true;
  return isgenesisKeyShape(trimmed);
}

/**
 * True when the request presents a genesis API key credential attempt.
 * Gateway-shaped Bearer, ApiKey/Api-Key, raw sk-, and x-api-key count; Basic and
 * provider OAuth/JWT do not block loopback no-auth bypass.
 */
export function hasgenesisCredentialAttempt(request) {
  const xApiKey = request.headers.get("x-api-key")?.trim();
  if (xApiKey && looksLikegenesisApiKey(xApiKey)) {
    if (isVerifiableGatewayToken(xApiKey)) return true;
    // Stale shaped x-api-key must not block loopback when a provider credential is also present.
    if (!allowsStaleGatewayBypass(request)) return true;
  }

  const authToken = extractAuthorizationCredentialToken(request);
  if (!authToken || !looksLikegenesisApiKey(authToken)) return false;
  if (isVerifiableGatewayToken(authToken)) return true;
  if (!allowsStaleGatewayBypass(request)) return true;
  return false;
}

export { maskApiKeyForDisplay } from "./apiKeyDisplay.js";

