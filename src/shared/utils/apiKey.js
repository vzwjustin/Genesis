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

/** Mask API key for list display — never expose full secret in GET responses. */
export function maskApiKeyForDisplay(apiKey) {
  if (!apiKey || typeof apiKey !== "string") return "";
  if (apiKey.length <= 16) return `${apiKey.slice(0, 4)}…`;
  return `${apiKey.slice(0, 12)}…${apiKey.slice(-4)}`;
}

