// Circuit breaker per upstream provider — prevents cascading failures by failing fast
// when a provider is consistently unhealthy.
//
// States: closed (pass-through) → open (fail-fast) → half-open (single probe) → closed/open
// Fail-open: if this module itself errors internally, canRequest() returns { allowed: true }.

/**
 * Parse an integer env var within [min, max], falling back to defaultVal with a warning.
 */
function parseEnvInt(name, defaultVal, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultVal;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    console.warn(
      `[CircuitBreaker] Invalid ${name}="${raw}" (must be integer ${min}–${max}), using default ${defaultVal}`
    );
    return defaultVal;
  }
  return parsed;
}

/**
 * Create a fresh per-provider state object.
 */
function createProviderState() {
  return {
    state: "closed",
    consecutiveFailures: 0,
    lastFailureTime: null,
    probeInFlight: false,
    probeStartedAt: null,
  };
}

/**
 * Factory: creates a circuit breaker instance with the given options.
 * @param {{ failureThreshold?: number, cooldownMs?: number }} [options]
 */
export function createCircuitBreaker(options = {}) {
  const failureThreshold = options.failureThreshold ?? parseEnvInt("CB_FAILURE_THRESHOLD", 5, 1, 100);
  const cooldownMs = options.cooldownMs ?? parseEnvInt("CB_COOLDOWN_MS", 30000, 1000, 300000);
  // A half-open probe that never reports back (canRequest set probeInFlight=true,
  // but the request was aborted before any success/failure was recorded) must not
  // wedge the breaker forever. Treat an in-flight probe older than this as stale.
  const probeTimeoutMs = options.probeTimeoutMs ?? parseEnvInt("CB_PROBE_TIMEOUT_MS", 120000, 1000, 600000);

  /** @type {Map<string, ReturnType<typeof createProviderState>>} */
  const providers = new Map();

  function getOrCreate(provider) {
    let s = providers.get(provider);
    if (!s) {
      s = createProviderState();
      providers.set(provider, s);
    }
    return s;
  }

  /**
   * Check whether a request to `provider` is allowed.
   * @param {string} provider
   * @returns {{ allowed: boolean, retryAfter?: number }}
   */
  function canRequest(provider) {
    try {
      const s = getOrCreate(provider);

      if (s.state === "closed") {
        return { allowed: true };
      }

      // Release a stale probe slot so a fresh probe can run (self-heal for the
      // abort-during-probe leak: a probe with no recorded outcome past timeout).
      if (s.probeInFlight && s.probeStartedAt != null && (Date.now() - s.probeStartedAt) >= probeTimeoutMs) {
        s.probeInFlight = false;
        s.probeStartedAt = null;
      }

      if (s.state === "open") {
        const elapsed = Date.now() - s.lastFailureTime;
        if (elapsed >= cooldownMs) {
          // Single probe after cooldown — reject concurrent waiters.
          if (s.probeInFlight) {
            return { allowed: false, retryAfter: 5 };
          }
          s.state = "half-open";
          s.probeInFlight = true;
          s.probeStartedAt = Date.now();
          return { allowed: true };
        }
        const remainingSec = Math.ceil((cooldownMs - elapsed) / 1000);
        return { allowed: false, retryAfter: Math.max(1, remainingSec) };
      }

      // half-open — at most one probe in flight
      if (!s.probeInFlight) {
        s.probeInFlight = true;
        s.probeStartedAt = Date.now();
        return { allowed: true };
      }
      return { allowed: false, retryAfter: 5 };
    } catch {
      // Fail-open: internal error → allow
      return { allowed: true };
    }
  }

  /**
   * Record a successful response from `provider`.
   * @param {string} provider
   */
  function recordSuccess(provider) {
    try {
      const s = getOrCreate(provider);

      if (s.state === "half-open") {
        // Probe succeeded — close circuit
        s.state = "closed";
        s.consecutiveFailures = 0;
        s.probeInFlight = false;
        s.probeStartedAt = null;
        return;
      }

      // In closed state, reset failure counter
      s.consecutiveFailures = 0;
    } catch {
      // fail-open — swallow
    }
  }

  /**
   * Record a failure response from `provider`.
   * @param {string} provider
   */
  function recordFailure(provider) {
    try {
      const s = getOrCreate(provider);

      if (s.state === "half-open") {
        // Probe failed — reopen circuit
        s.state = "open";
        s.lastFailureTime = Date.now();
        s.probeInFlight = false;
        s.probeStartedAt = null;
        return;
      }

      if (s.state === "open") {
        // Already open — do NOT re-stamp lastFailureTime. Failures from
        // in-flight/concurrent requests must not push the cooldown window
        // forward, or the circuit never reaches half-open.
        return;
      }

      // Closed state — increment counter
      s.consecutiveFailures += 1;
      s.lastFailureTime = Date.now();

      if (s.consecutiveFailures >= failureThreshold) {
        s.state = "open";
      }
    } catch {
      // fail-open — swallow
    }
  }

  /**
   * Get current circuit state for a provider.
   * @param {string} provider
   * @returns {'closed'|'open'|'half-open'}
   */
  function getState(provider) {
    try {
      const s = providers.get(provider);
      if (!s) return "closed";

      // Check if open state should transition to half-open based on elapsed time
      if (s.state === "open" && s.lastFailureTime !== null) {
        const elapsed = Date.now() - s.lastFailureTime;
        if (elapsed >= cooldownMs) {
          return "half-open";
        }
      }

      return s.state;
    } catch {
      return "closed";
    }
  }

  /**
   * Release a probe slot taken by canRequest when the request neither succeeded
   * nor failed upstream (e.g. client abort before any response). Leaves the
   * circuit state unchanged so the next request can probe again — without this,
   * an aborted half-open probe would wedge the breaker until process restart.
   * @param {string} provider
   */
  function recordProbeRelease(provider) {
    try {
      const s = providers.get(provider);
      if (!s) return;
      if (s.probeInFlight) {
        s.probeInFlight = false;
        s.probeStartedAt = null;
      }
    } catch {
      // fail-open — swallow
    }
  }

  /**
   * Get states for all tracked providers.
   * @returns {Record<string, 'closed'|'open'|'half-open'>}
   */
  function getAllStates() {
    try {
      const result = {};
      for (const [provider] of providers) {
        result[provider] = getState(provider);
      }
      return result;
    } catch {
      return {};
    }
  }

  return { canRequest, recordSuccess, recordFailure, recordProbeRelease, getState, getAllStates };
}

/** Singleton circuit breaker configured from environment variables */
export const circuitBreaker = createCircuitBreaker();

// ---------------------------------------------------------------------------
// Provider Reachability Tracker
// ---------------------------------------------------------------------------
// Lightweight in-memory singleton tracking whether each provider is reachable.
// Updated on every upstream response outcome. Consumed by the health endpoint
// to report `providers` (reachable boolean) and `last_errors` (ISO timestamp).
//
// A provider is reachable after any 2xx/4xx response.
// A provider is unreachable after a 5xx or network error.

/**
 * Factory: creates a provider reachability tracker.
 */
export function createProviderReachability() {
  /** @type {Map<string, {reachable: boolean, lastErrorAt: string|null}>} */
  const state = new Map();

  /**
   * Mark a provider as reachable (received 2xx or 4xx).
   * Keeps lastErrorAt unchanged — we only update it on errors.
   * @param {string} provider
   */
  function recordReachable(provider) {
    try {
      const existing = state.get(provider);
      if (existing) {
        existing.reachable = true;
      } else {
        state.set(provider, { reachable: true, lastErrorAt: null });
      }
    } catch {
      // fail-open — swallow
    }
  }

  /**
   * Mark a provider as unreachable (received 5xx or network error).
   * Updates lastErrorAt to current ISO timestamp.
   * @param {string} provider
   */
  function recordUnreachable(provider) {
    try {
      const now = new Date().toISOString();
      const existing = state.get(provider);
      if (existing) {
        existing.reachable = false;
        existing.lastErrorAt = now;
      } else {
        state.set(provider, { reachable: false, lastErrorAt: now });
      }
    } catch {
      // fail-open — swallow
    }
  }

  /**
   * Get the full reachability map as a plain object.
   * @returns {Record<string, {reachable: boolean, lastErrorAt: string|null}>}
   */
  function getAll() {
    try {
      const result = {};
      for (const [provider, entry] of state) {
        result[provider] = { reachable: entry.reachable, lastErrorAt: entry.lastErrorAt };
      }
      return result;
    } catch {
      return {};
    }
  }

  return { recordReachable, recordUnreachable, getAll };
}

/** Singleton provider reachability tracker */
export const providerReachability = createProviderReachability();
