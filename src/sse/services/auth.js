import { getProviderConnections, getProviderConnectionById, validateApiKey, updateProviderConnection, getSettings, getSettingsSafe } from "@/lib/localDb";
import { errorResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { formatRetryAfter, checkFallbackError, isModelLockActive, buildModelLockUpdate, getEarliestModelLockUntil, getEarliestRateLimitedUntil } from "open-sse/services/accountFallback.js";
import { MAX_RATE_LIMIT_COOLDOWN_MS } from "open-sse/config/errorConfig.js";
import { resolveProviderId, FREE_PROVIDERS } from "@/shared/constants/providers.js";
import {
  parseApiKey,
  verifyApiKeyCrc,
  isLocalhostSentinelKey,
  hasgenesisCredentialAttempt,
  getGatewayApiKeyCandidates,
} from "@/shared/utils/apiKey.js";
import { isVerifiableLoopbackRequest } from "@/shared/utils/loopbackRequest.js";
import { hasValidLocalCliToken } from "@/shared/auth/cliToken.js";
import { strictProxyFieldFromResolved } from "open-sse/utils/proxyFetch.js";
import * as log from "../utils/logger.js";

// Mutex to prevent race conditions during account selection and state updates
let selectionMutex = Promise.resolve();
let accountStateMutex = Promise.resolve();

/**
 * Get provider credentials from localDb
 * Filters out unavailable accounts and returns the selected account based on strategy
 * @param {string} provider - Provider name
 * @param {Set<string>|string|null} excludeConnectionIds - Connection ID(s) to exclude (for retry with next account)
 * @param {string|null} model - Model name for per-model rate limit filtering
 */
export async function getProviderCredentials(provider, excludeConnectionIds = null, model = null, options = {}) {
  // Normalize to Set for consistent handling
  const excludeSet = excludeConnectionIds instanceof Set
    ? excludeConnectionIds
    : (excludeConnectionIds ? new Set([excludeConnectionIds]) : new Set());
  const preferredConnectionId = options?.preferredConnectionId || null;
  // Acquire mutex to prevent race conditions
  const currentMutex = selectionMutex;
  let resolveMutex;
  selectionMutex = new Promise(resolve => { resolveMutex = resolve; });

  try {
    await currentMutex;

    // Resolve alias to provider ID (e.g., "kc" -> "kilocode")
    const providerId = resolveProviderId(provider);

    // Inject a virtual connection for no-auth free providers (with optional proxy pool from settings)
    if (FREE_PROVIDERS[providerId]?.noAuth) {
      const settings = await getSettingsSafe();
      const override = (settings.providerStrategies || {})[providerId] || {};
      const resolvedProxy = await resolveConnectionProxyConfig({ proxyPoolId: override.proxyPoolId || "" });
      return {
        id: "noauth",
        connectionId: "noauth",
        connectionName: "Public",
        isActive: true,
        accessToken: "public",
        providerSpecificData: {
          connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
          connectionProxyUrl: resolvedProxy.connectionProxyUrl,
          connectionNoProxy: resolvedProxy.connectionNoProxy,
          connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
          vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
          relayAuthSecret: resolvedProxy.relayAuthSecret || "",
          ...strictProxyFieldFromResolved(resolvedProxy),
          ...(resolvedProxy.proxyRequiredUnavailable ? { proxyRequiredUnavailable: true } : {}),
        },
      };
    }

    const connections = await getProviderConnections({ provider: providerId, isActive: true });
    log.debug("AUTH", `${provider} | total connections: ${connections.length}, excludeIds: ${excludeSet.size > 0 ? [...excludeSet].join(",") : "none"}, model: ${model || "any"}`);

    if (connections.length === 0) {
      log.warn("AUTH", `No credentials for ${provider}`);
      return null;
    }

    // Filter out model-locked, cooldown, excluded, and invalid-credential connections
    const now = Date.now();
    const availableConnections = connections.filter(c => {
      if (excludeSet.has(c.id)) return false;
      if (isModelLockActive(c, model)) return false;
      // Exclude connections with rateLimitedUntil in the future (legacy cooldown field)
      if (c.rateLimitedUntil && new Date(c.rateLimitedUntil).getTime() > now) return false;
      // Exclude connections with failed OAuth refresh / invalid credentials
      if (c.testStatus === "error") return false;
      return true;
    });

    log.debug("AUTH", `${provider} | available: ${availableConnections.length}/${connections.length}`);
    connections.forEach(c => {
      const excluded = excludeSet.has(c.id);
      const locked = isModelLockActive(c, model);
      const rateLimited = c.rateLimitedUntil && new Date(c.rateLimitedUntil).getTime() > now;
      const invalidCreds = c.testStatus === "error";
      if (excluded || locked || rateLimited || invalidCreds) {
        const lockUntil = getEarliestModelLockUntil(c);
        const reasons = [
          excluded ? "excluded" : "",
          locked ? `modelLocked(${model}) until ${lockUntil}` : "",
          rateLimited ? `rateLimited until ${c.rateLimitedUntil}` : "",
          invalidCreds ? "invalidCredentials(testStatus=error)" : "",
        ].filter(Boolean).join(", ");
        log.debug("AUTH", `  → ${c.id?.slice(0, 8)} | ${reasons}`);
      }
    });

    if (availableConnections.length === 0) {
      // Find earliest lock expiry across all connections for retry timing
      const lockedConns = connections.filter(c => isModelLockActive(c, model));
      const expiries = lockedConns.map(c => getEarliestModelLockUntil(c)).filter(Boolean);
      const earliest = expiries.sort()[0] || null;
      if (earliest) {
        const earliestConn = lockedConns[0];
        log.warn("AUTH", `${provider} | all ${connections.length} accounts locked for ${model || "all"} (${formatRetryAfter(earliest)}) | lastError=${earliestConn?.lastError?.slice(0, 50)}`);
        return {
          allRateLimited: true,
          retryAfter: earliest,
          retryAfterHuman: formatRetryAfter(earliest),
          lastError: earliestConn?.lastError || null,
          lastErrorCode: earliestConn?.errorCode || null
        };
      }
      const rateLimitedUntil = getEarliestRateLimitedUntil(connections);
      if (rateLimitedUntil) {
        const rateLimitedConn = connections.find((c) => c.rateLimitedUntil === rateLimitedUntil) || connections[0];
        log.warn("AUTH", `${provider} | all ${connections.length} accounts rate-limited (${formatRetryAfter(rateLimitedUntil)}) | lastError=${rateLimitedConn?.lastError?.slice(0, 50)}`);
        return {
          allRateLimited: true,
          retryAfter: rateLimitedUntil,
          retryAfterHuman: formatRetryAfter(rateLimitedUntil),
          lastError: rateLimitedConn?.lastError || null,
          lastErrorCode: rateLimitedConn?.errorCode || null
        };
      }
      log.warn("AUTH", `${provider} | all ${connections.length} accounts unavailable`);
      return null;
    }

    const settings = await getSettingsSafe();
    // Per-provider strategy overrides global setting
    const providerOverride = (settings.providerStrategies || {})[providerId] || {};
    const strategy = providerOverride.fallbackStrategy || settings.fallbackStrategy || "fill-first";

    let connection;
    // Pin to preferred connection if specified and available
    if (preferredConnectionId) {
      connection = availableConnections.find((c) => c.id === preferredConnectionId);
      if (connection) {
        log.info("AUTH", `${provider} | pinned to ${connection.id?.slice(0, 8)} (${connection.name || connection.email || "unnamed"})`);
      }
    }
    if (connection) {
      // skip strategy
    } else if (strategy === "round-robin") {
      const stickyLimit = providerOverride.stickyRoundRobinLimit || settings.stickyRoundRobinLimit || 3;

      // Priority-based sticky round-robin:
      // 1. Sort by priority (lower = higher priority)
      // 2. Find the current "active" connection (most recently used)
      // 3. Stick to it for stickyLimit consecutive requests
      // 4. Then rotate to the next connection in priority order
      //
      // CONCURRENCY: the read-modify-write of consecutiveUseCount below
      // (read current → await updateProviderConnection → write) is a TOCTOU
      // hazard, but it runs inside selectionMutex (acquired at the top of
      // getProviderCredentials, released in the finally), so all selections
      // are serialized in-process — concurrent requests cannot read the same
      // snapshot. Do NOT move this block outside the mutex. Residual caveat:
      // multiple processes sharing one DB are not serialized by this mutex;
      // sticky limits would need a DB-level atomic increment to hold there.

      const byPriority = [...availableConnections].sort((a, b) => (a.priority || 999) - (b.priority || 999));

      // Find the most recently used connection among available ones (the "current" one)
      const byRecency = [...availableConnections].sort((a, b) => {
        if (!a.lastUsedAt && !b.lastUsedAt) return 0;
        if (!a.lastUsedAt) return 1;
        if (!b.lastUsedAt) return -1;
        return new Date(b.lastUsedAt) - new Date(a.lastUsedAt);
      });
      const current = byRecency[0];
      const currentCount = current?.consecutiveUseCount || 0;

      if (!current || !current.lastUsedAt) {
        // No connection has been used yet — start with highest priority
        connection = byPriority[0];
        await updateProviderConnection(connection.id, {
          consecutiveUseCount: 1
        });
      } else if (currentCount < stickyLimit) {
        // Sticky: stay with current connection until limit reached
        connection = current;
        await updateProviderConnection(connection.id, {
          consecutiveUseCount: currentCount + 1
        });
      } else {
        // Rotate: advance to the next connection in priority order
        // Find the current connection's position in priority-sorted list
        const currentIdx = byPriority.findIndex(c => c.id === current.id);
        // Next in priority order (wrap around)
        const nextIdx = (currentIdx + 1) % byPriority.length;
        connection = byPriority[nextIdx];

        // Reset count to 1 for the newly selected connection
        await updateProviderConnection(connection.id, {
          consecutiveUseCount: 1
        });
      }
    } else {
      // Default: fill-first (already sorted by priority in getProviderConnections)
      connection = availableConnections[0];
    }

    const resolvedProxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});

    return {
      authType: connection.authType,
      apiKey: connection.apiKey,
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      projectId: connection.projectId,
      connectionName: connection.displayName || connection.name || connection.email || connection.id,
      copilotToken: connection.providerSpecificData?.copilotToken,
      providerSpecificData: {
        ...(connection.providerSpecificData || {}),
        connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
        connectionProxyUrl: resolvedProxy.connectionProxyUrl,
        connectionNoProxy: resolvedProxy.connectionNoProxy,
        connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
        vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
        relayAuthSecret: resolvedProxy.relayAuthSecret || "",
        ...strictProxyFieldFromResolved(resolvedProxy),
        ...(resolvedProxy.proxyRequiredUnavailable ? { proxyRequiredUnavailable: true } : { proxyRequiredUnavailable: false }),
      },
      connectionId: connection.id,
      // Include current status for optimization check
      testStatus: connection.testStatus,
      lastError: connection.lastError,
      // Pass full connection for clearAccountError to read modelLock_* keys
      _connection: connection
    };
  } finally {
    if (resolveMutex) resolveMutex();
  }
}

/**
 * Mark account+model as unavailable — locks modelLock_${model} in DB.
 * All errors (429, 401, 5xx, etc.) lock per model, not per account.
 * @param {string} connectionId
 * @param {number} status - HTTP status code from upstream
 * @param {string} errorText
 * @param {string|null} provider
 * @param {string|null} model - The specific model that triggered the error
 * @returns {{ shouldFallback: boolean, cooldownMs: number }}
 */
export async function markAccountUnavailable(connectionId, status, errorText, provider = null, model = null, resetsAtMs = null, meta = {}) {
  if (!connectionId || connectionId === "noauth") return { shouldFallback: false, cooldownMs: 0 };

  const currentMutex = accountStateMutex;
  let resolveMutex;
  accountStateMutex = new Promise(resolve => { resolveMutex = resolve; });

  try {
    await currentMutex;

    const connections = await getProviderConnections({ provider });
    const conn = connections.find(c => c.id === connectionId);
    const backoffLevel = conn?.backoffLevel || 0;

    // Provider-specific precise cooldown (e.g. codex usage_limit_reached resets_at) overrides backoff
    let shouldFallback, cooldownMs, newBackoffLevel;
    if (resetsAtMs && resetsAtMs > Date.now()) {
      shouldFallback = true;
      cooldownMs = Math.min(resetsAtMs - Date.now(), MAX_RATE_LIMIT_COOLDOWN_MS);
      newBackoffLevel = 0;
    } else {
      ({ shouldFallback, cooldownMs, newBackoffLevel } = checkFallbackError(status, errorText, backoffLevel, meta));
    }
    if (!shouldFallback) {
      const conn = connections.find((c) => c.id === connectionId);
      const rolledBackUseCount = Math.max(0, (conn?.consecutiveUseCount || 0) - 1);
      if (conn && rolledBackUseCount !== conn.consecutiveUseCount) {
        await updateProviderConnection(connectionId, { consecutiveUseCount: rolledBackUseCount });
      }
      return { shouldFallback: false, cooldownMs: 0 };
    }

    const reason = typeof errorText === "string" ? errorText.slice(0, 100) : "Provider error";
    const lockUpdate = buildModelLockUpdate(model, cooldownMs);

    // Round-robin bumps consecutiveUseCount at selection, before the request is
    // known to succeed. If this connection just failed and we're falling back,
    // roll that bump back so a failed attempt doesn't consume a sticky slot and
    // starve healthy accounts (rotation counts successes, not attempts).
    const rolledBackUseCount = Math.max(0, (conn?.consecutiveUseCount || 0) - 1);

    await updateProviderConnection(connectionId, {
      ...lockUpdate,
      testStatus: "unavailable",
      lastError: reason,
      errorCode: status,
      lastErrorAt: new Date().toISOString(),
      backoffLevel: newBackoffLevel ?? backoffLevel,
      consecutiveUseCount: rolledBackUseCount
    });

    const lockKey = Object.keys(lockUpdate)[0];
    const connName = conn?.displayName || conn?.name || conn?.email || connectionId.slice(0, 8);
    log.warn("AUTH", `${connName} locked ${lockKey} for ${Math.round(cooldownMs / 1000)}s [${status}]`);

    if (provider && status && reason) {
      console.error(`❌ ${provider} [${status}]: ${reason}`);
    }

    return { shouldFallback: true, cooldownMs };
  } finally {
    if (resolveMutex) resolveMutex();
  }
}

/**
 * Clear account error status on successful request.
 * - Clears modelLock_${model} (the model that just succeeded)
 * - Lazy-cleans any other expired modelLock_* keys
 * - Resets error state only if no active locks remain
 * @param {string} connectionId
 * @param {object} currentConnection - credentials object (has _connection) or raw connection
 * @param {string|null} model - model that succeeded
 */
export async function clearAccountError(connectionId, currentConnection, model = null) {
  if (!connectionId || connectionId === "noauth") return;

  const currentMutex = accountStateMutex;
  let resolveMutex;
  accountStateMutex = new Promise((resolve) => { resolveMutex = resolve; });

  try {
    await currentMutex;

  const freshConn = (await getProviderConnectionById(connectionId))
    || currentConnection._connection
    || currentConnection;
  const conn = freshConn;
  const now = Date.now();
  const allLockKeys = Object.keys(conn).filter(k => k.startsWith("modelLock_"));

  if (!conn.testStatus && !conn.lastError && !conn.rateLimitedUntil && allLockKeys.length === 0) return;

  // Keys to clear: current model's lock + account-level lock + all expired locks
  const keysToClear = allLockKeys.filter(k => {
    if (model && k === `modelLock_${model}`) return true;
    if (k === "modelLock___all") return true;
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() <= now;
  });

  if (keysToClear.length === 0 && conn.testStatus !== "unavailable" && !conn.lastError && !conn.rateLimitedUntil) return;

  // Check if any active locks remain after clearing
  const remainingActiveLocks = allLockKeys.filter(k => {
    if (keysToClear.includes(k)) return false;
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() > now;
  });

  const clearObj = Object.fromEntries(keysToClear.map(k => [k, null]));

  // Only reset error state if no active locks remain
  if (remainingActiveLocks.length === 0) {
    Object.assign(clearObj, { testStatus: "active", lastError: null, lastErrorAt: null, backoffLevel: 0, rateLimitedUntil: null });
  }

  // Record successful use for round-robin recency (deferred from selection until success)
  clearObj.lastUsedAt = new Date().toISOString();

  await updateProviderConnection(connectionId, clearObj);
  } finally {
    if (resolveMutex) resolveMutex();
  }
}

/**
 * Roll back a selection-time sticky round-robin bump after a failed/incomplete attempt.
 */
export async function rollbackStickyUseCount(connectionId) {
  if (!connectionId || connectionId === "noauth") return;

  const currentMutex = accountStateMutex;
  let resolveMutex;
  accountStateMutex = new Promise((resolve) => { resolveMutex = resolve; });

  try {
    await currentMutex;
    const conn = await getProviderConnectionById(connectionId);
    if (!conn) return;
    const current = conn.consecutiveUseCount || 0;
    if (current <= 0) return;
    await updateProviderConnection(connectionId, { consecutiveUseCount: Math.max(0, current - 1) });
  } finally {
    if (resolveMutex) resolveMutex();
  }
}

/**
 * Enforce API key rules for SSE handlers.
 * - Invalid gateway credentials are rejected
 * - No-auth bypass when no gateway credential attempt is present
 */
export async function authenticateRequest(request, log) {
  // Fail CLOSED for the auth gate: getSettingsSafe() returns permissive defaults
  // (requireApiKey:false) when the DB read throws, which would silently DROP key
  // enforcement. Probe with the strict reader; if it throws, keep safe defaults
  // for shape but force requireApiKey=true.
  let settings;
  try {
    settings = await getSettings();
  } catch {
    settings = { ...(await getSettingsSafe()), requireApiKey: true };
  }

  if (await hasValidLocalCliToken(request)) {
    log?.debug?.("AUTH", "Authenticated via local CLI token");
    return { ok: true, apiKey: null, settings, cliToken: true };
  }

  const hasCredentialHeader = hasgenesisCredentialAttempt(request);
  const candidates = hasCredentialHeader ? getGatewayApiKeyCandidates(request) : [];
  // The localhost sentinel key represents "no configured key on loopback"; it
  // must NOT override an explicit requireApiKey=true (which demands a real key).
  const allowLocalhostSentinel = settings?.requireApiKey !== true;
  let apiKey = null;
  for (const candidate of candidates) {
    if (await isValidApiKey(candidate, request, { allowLocalhostSentinel })) {
      apiKey = candidate;
      break;
    }
  }

  if (hasCredentialHeader) {
    if (!apiKey) {
      log?.warn?.("AUTH", "Invalid API key (credential header present)");
      return {
        ok: false,
        response: errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key", { errorType: "unauthorized" }),
      };
    }
    const parsedKey = parseApiKey(apiKey);
    const keyIdSuffix = parsedKey?.keyId ? ` id=${parsedKey.keyId}` : "";
    log?.debug?.("AUTH", `Authenticated | key=${log?.maskKey ? log.maskKey(apiKey) : "***"}${keyIdSuffix}`);
    return { ok: true, apiKey, settings, keyId: parsedKey?.keyId || null };
  }

  if (settings?.requireApiKey === true) {
    log?.warn?.("AUTH", "Missing API key (requireApiKey=true)");
    return {
      ok: false,
      response: errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key", { errorType: "unauthorized" }),
    };
  }

  if (!isVerifiableLoopbackRequest(request)) {
    log?.warn?.("AUTH", "Missing API key (remote access requires key)");
    return {
      ok: false,
      response: errorResponse(HTTP_STATUS.UNAUTHORIZED, "API key required for remote API access", { errorType: "unauthorized" }),
    };
  }

  log?.debug?.("AUTH", "Authentication bypassed (requireApiKey=false, loopback, no credentials)");
  return { ok: true, apiKey: null, settings, bypassed: true };
}

export { extractApiKey } from "@/shared/utils/apiKey.js";

/**
 * Validate API key (optional - for local use can skip)
 */
export async function isValidApiKey(apiKey, request = null, { allowLocalhostSentinel = true } = {}) {
  if (!apiKey) return false;
  if (isLocalhostSentinelKey(apiKey)) {
    // Honor the loopback sentinel only when key enforcement is off; with
    // requireApiKey=true a real provisioned key is required even on loopback.
    if (!allowLocalhostSentinel) return false;
    return request ? isVerifiableLoopbackRequest(request) : false;
  }
  if (!verifyApiKeyCrc(apiKey)) return false;
  return await validateApiKey(apiKey);
}
