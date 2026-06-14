// API key parsing/verification for the Cloudflare Workers cloud relay.
//
// Mirrors the CRC scheme in src/shared/utils/apiKey.js but uses Web Crypto
// (crypto.subtle) instead of node:crypto so it runs natively on Workers.
//
// Key format (new): sk-{machineId}-{keyId}-{crc8}
//            (old): sk-{keyId}
//
// CRC is the first 8 hex chars of HMAC-SHA256(machineId + keyId) keyed by the
// install secret. The Worker learns the machineId from the key, fetches the
// machine's stored keys, and the exact-match check in the handler
// (isKeyAllowed) is the authoritative auth gate; CRC verification here guards
// key shape/integrity. Configure API_KEY_SECRET (via process.env under
// nodejs_compat, or globalThis) to match the issuing install; keys signed with
// the legacy default secret are always accepted.

const LEGACY_API_KEY_SECRET = "endpoint-proxy-api-key-secret";

/** Configured install secret, if exposed to the Worker, else null. */
function getConfiguredSecret() {
  if (typeof process !== "undefined" && process.env && process.env.API_KEY_SECRET) {
    return process.env.API_KEY_SECRET;
  }
  if (typeof globalThis !== "undefined" && globalThis.API_KEY_SECRET) {
    return globalThis.API_KEY_SECRET;
  }
  return null;
}

/** HMAC-SHA256(message) keyed by secret, returned as lowercase hex. */
async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function crcForSecret(machineId, keyId, secret) {
  return (await hmacHex(secret, machineId + keyId)).slice(0, 8);
}

/**
 * Constant-time string equality. Comparing a MAC with `===` short-circuits on
 * the first mismatched char, leaking a timing oracle that narrows the value
 * char-by-char. Length is compared into the accumulator (not early-returned) so
 * unequal-length inputs still take data-independent time.
 */
function timingSafeStrEqual(a, b) {
  const sa = String(a);
  const sb = String(b);
  let diff = sa.length ^ sb.length;
  for (let i = 0; i < sa.length; i++) {
    diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i % sb.length);
  }
  return diff === 0;
}

/** Accept keys signed with the configured install secret or the legacy default. */
async function verifyCrc(machineId, keyId, crc) {
  const secrets = [];
  const configured = getConfiguredSecret();
  if (configured) secrets.push(configured);
  if (!secrets.includes(LEGACY_API_KEY_SECRET)) secrets.push(LEGACY_API_KEY_SECRET);

  let ok = false;
  // Check every secret (no early break) so timing does not reveal which secret matched.
  for (const secret of secrets) {
    if (timingSafeStrEqual(await crcForSecret(machineId, keyId, secret), crc)) ok = true;
  }
  return ok;
}

/**
 * Extract a Bearer token from a Request's Authorization header.
 * Only the Bearer scheme is accepted; anything else returns null.
 * @param {Request} request
 * @returns {string | null}
 */
export function extractBearerToken(request) {
  const auth = request?.headers?.get?.("Authorization")?.trim();
  if (!auth) return null;
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1].trim();
  return token || null;
}

/**
 * Parse a 9router API key and extract machineId + keyId.
 * - New format: sk-{machineId}-{keyId}-{crc8} (CRC-verified)
 * - Old format: sk-{keyId}
 * @param {string} apiKey
 * @returns {Promise<{ machineId: string | null, keyId: string, isNewFormat: boolean } | null>}
 */
export async function parseApiKey(apiKey) {
  if (!apiKey || typeof apiKey !== "string" || !apiKey.startsWith("sk-")) return null;

  const parts = apiKey.split("-");

  // New format: sk-{machineId}-{keyId}-{crc8} = 4 parts
  if (parts.length === 4) {
    const [, machineId, keyId, crc] = parts;
    if (!(await verifyCrc(machineId, keyId, crc))) return null;
    return { machineId, keyId, isNewFormat: true };
  }

  // Old format: sk-{keyId} = 2 parts
  if (parts.length === 2) {
    return { machineId: null, keyId: parts[1], isNewFormat: false };
  }

  return null;
}
