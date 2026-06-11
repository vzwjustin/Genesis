import crypto from "crypto";
import { getApiKeySecret, LEGACY_API_KEY_SECRET } from "./apiKeySecret.js";

/**
 * Generate 6-char random keyId
 */
function generateKeyId() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
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

/** Accept keys signed with the current or legacy default secret. */
function verifyCrc(machineId, keyId, crc) {
  const secrets = [getApiKeySecret()];
  if (!secrets.includes(LEGACY_API_KEY_SECRET)) secrets.push(LEGACY_API_KEY_SECRET);
  return secrets.some((secret) => crcForSecret(machineId, keyId, secret) === crc);
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
export const LOCALHOST_SENTINEL_API_KEY = "sk_9router";

export function isLocalhostSentinelKey(apiKey) {
  return apiKey === LOCALHOST_SENTINEL_API_KEY;
}

const PROVIDER_API_KEY_PREFIXES = ["sk-ant-", "sk-proj-", "sk-or-"];

function isProviderApiKeyPrefix(token) {
  return PROVIDER_API_KEY_PREFIXES.some((prefix) => token.startsWith(prefix));
}

/** sk-{machineId}-{keyId}-{crc8} or legacy sk-{id} — gateway-managed keys only. */
export function is9routerKeyShape(token) {
  if (!token || typeof token !== "string" || !token.startsWith("sk-")) return false;
  if (isProviderApiKeyPrefix(token)) return false;
  const parts = token.split("-");
  if (parts.length === 4 && /^[0-9a-f]{8}$/i.test(parts[3])) return true;
  if (parts.length === 2 && parts[1].length >= 4) return true;
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

/** Prefer gateway-shaped credentials (x-api-key wins over non-gateway Bearer). */
export function extractGatewayApiKey(request) {
  const xApiKey = request.headers.get("x-api-key")?.trim();
  if (xApiKey && looksLike9routerApiKey(xApiKey)) return xApiKey;

  const bearer = extractBearerToken(request.headers.get("Authorization"));
  if (bearer && looksLike9routerApiKey(bearer)) return bearer;

  return null;
}

/** Extract Bearer or x-api-key credential token (trimmed, Bearer first). */
export function extractApiKey(request) {
  const bearer = extractBearerToken(request.headers.get("Authorization"));
  if (bearer) return bearer;
  const xApiKey = request.headers.get("x-api-key")?.trim();
  return xApiKey || null;
}

/**
 * True when a header value is intended as 9router gateway auth (not provider OAuth/JWT).
 * OAuth/JWT and provider keys (sk-ant-*, sk-proj-*, etc.) are ignored for gateway auth.
 */
export function looksLike9routerApiKey(token) {
  if (!token || typeof token !== "string") return false;
  const trimmed = token.trim();
  if (isLocalhostSentinelKey(trimmed)) return true;
  return is9routerKeyShape(trimmed);
}

/**
 * True when the request presents a 9router API key credential attempt.
 * Malformed Authorization (non-Bearer) still counts as a credential attempt.
 */
export function has9routerCredentialAttempt(request) {
  const xApiKey = request.headers.get("x-api-key")?.trim();
  if (xApiKey && looksLike9routerApiKey(xApiKey)) return true;

  const auth = request.headers.get("Authorization")?.trim();
  if (!auth) return false;

  if (/^Bearer\s+/i.test(auth)) {
    const token = extractBearerToken(auth);
    return !!token && looksLike9routerApiKey(token);
  }

  return true;
}

export { maskApiKeyForDisplay } from "./apiKeyDisplay.js";

