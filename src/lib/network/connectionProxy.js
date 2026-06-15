import { getProxyPoolById } from "@/models";

// Safely normalize any value into a trimmed string.
function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

// Validate a proxy URL. The undici-based dispatcher only supports http/https
// proxies, so reject anything else. Returns "" (treat as no-proxy) on invalid.
const SUPPORTED_PROXY_SCHEMES = new Set(["http:", "https:"]);
function validateProxyUrl(value) {
  const raw = normalizeString(value);
  if (!raw) return "";
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    console.warn("[resolveConnectionProxyConfig] Invalid proxy URL, ignoring:", raw);
    return "";
  }
  if (!SUPPORTED_PROXY_SCHEMES.has(parsed.protocol)) {
    console.warn("[resolveConnectionProxyConfig] Unsupported proxy scheme, ignoring:", parsed.protocol);
    return "";
  }
  return raw;
}

function resolveProxyPoolStrictProxy(proxyPool) {
  if (!proxyPool || !Object.prototype.hasOwnProperty.call(proxyPool, "strictProxy")) {
    return undefined;
  }
  return proxyPool.strictProxy === true;
}

/**
 * Normalize legacy proxy configuration.
 */
function normalizeLegacyProxy(providerSpecificData = {}) {
  const connectionProxyEnabled =
    providerSpecificData?.connectionProxyEnabled === true;

  const connectionProxyUrl = validateProxyUrl(
    providerSpecificData?.connectionProxyUrl
  );

  const connectionNoProxy = normalizeString(
    providerSpecificData?.connectionNoProxy
  );

  return {
    connectionProxyEnabled,
    connectionProxyUrl,
    connectionNoProxy,
  };
}

/**
 * Resolve final proxy configuration.
 *
 * Priority:
 * 1. Proxy Pool
 * 2. Legacy Proxy
 * 3. No Proxy
 */
export async function resolveConnectionProxyConfig(
  providerSpecificData = {}
) {
  try {
    const proxyPoolIdRaw = normalizeString(
      providerSpecificData?.proxyPoolId
    );

    // "__none__" means explicitly disabled
    const proxyPoolId =
      proxyPoolIdRaw === "__none__" ? "" : proxyPoolIdRaw;

    const legacy = normalizeLegacyProxy(providerSpecificData);

    /**
     * -----------------------------
     * Proxy Pool Resolution
     * -----------------------------
     */
    if (proxyPoolId) {
      const proxyPool = await getProxyPoolById(proxyPoolId);

      const proxyUrl = validateProxyUrl(proxyPool?.proxyUrl);
      const noProxy = normalizeString(proxyPool?.noProxy);

      const isValidPool =
        proxyPool &&
        proxyPool.isActive === true &&
        proxyUrl;

      if (isValidPool) {
        /**
         * Vercel/Cloudflare relay proxies use base URL rewriting
         * instead of HTTP_PROXY environment variables.
         */
        if (proxyPool.type === "vercel" || proxyPool.type === "cloudflare" || proxyPool.type === "deno") {
          const strictProxy = resolveProxyPoolStrictProxy(proxyPool);
          return {
            source: proxyPool.type,

            proxyPoolId,
            proxyPool,

            connectionProxyEnabled: false,
            connectionProxyUrl: "",
            connectionNoProxy: noProxy,

            ...(strictProxy !== undefined ? { strictProxy } : {}),

            vercelRelayUrl: proxyUrl, // Still mapped to vercelRelayUrl in the unified payload since they use the exact same header spec
            relayAuthSecret: normalizeString(proxyPool.relayAuthSecret),
          };
        }

        /**
         * Standard proxy pool
         */
        const strictProxy = resolveProxyPoolStrictProxy(proxyPool);
        return {
          source: "pool",

          proxyPoolId,
          proxyPool,

          connectionProxyEnabled: true,
          connectionProxyUrl: proxyUrl,
          connectionNoProxy: noProxy,

          ...(strictProxy !== undefined ? { strictProxy } : {}),
        };
      }
    }

    /**
     * -----------------------------
     * Legacy Proxy Fallback
     * -----------------------------
     */
    if (
      legacy.connectionProxyEnabled &&
      legacy.connectionProxyUrl
    ) {
      return {
        source: "legacy",

        proxyPoolId: proxyPoolId || null,
        proxyPool: null,

        ...legacy,
      };
    }

    /**
     * -----------------------------
     * No Proxy Config
     * -----------------------------
     */
    return {
      source: "none",

      proxyPoolId: proxyPoolId || null,
      proxyPool: null,

      ...legacy,
    };
  } catch (error) {
    console.error(
      "[resolveConnectionProxyConfig] Failed to resolve proxy config:",
      error
    );

    const legacy = normalizeLegacyProxy(providerSpecificData);
    const strictProxy = Object.prototype.hasOwnProperty.call(providerSpecificData, "strictProxy")
      ? providerSpecificData.strictProxy === true
      : undefined;

    return {
      source: "error",

      proxyPoolId: null,
      proxyPool: null,

      connectionProxyEnabled: false,
      connectionProxyUrl: "",
      connectionNoProxy: "",

      ...legacy,
      ...(strictProxy !== undefined ? { strictProxy } : {}),
    };
  }
}
