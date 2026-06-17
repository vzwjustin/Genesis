// Optional upstream observability — circuit breaker, reachability, latency.
// All paths fail open: telemetry must never interrupt the request path.

import { circuitBreaker, providerReachability } from "./circuitBreaker.js";
import { latencyStore } from "./latencyMetrics.js";

/**
 * Check whether the circuit breaker allows a request to `provider`.
 * @returns {{ denied: false } | { denied: true, retryAfter: number }}
 */
export function checkCircuitBreaker(provider) {
  try {
    const result = circuitBreaker.canRequest(provider);
    if (!result.allowed) {
      return { denied: true, retryAfter: Math.max(1, result.retryAfter ?? 1) };
    }
  } catch {
    // Fail open
  }
  return { denied: false };
}

/**
 * Release a circuit-breaker probe slot taken by checkCircuitBreaker when the
 * request was aborted before any upstream outcome (no success/failure recorded).
 * Prevents an aborted half-open probe from wedging the breaker. Fail-open.
 * @param {string} provider
 */
export function releaseCircuitProbe(provider) {
  try {
    circuitBreaker.recordProbeRelease(provider);
  } catch {
    // Fail open
  }
}

/**
 * Record circuit-breaker state, provider reachability, and latency after an upstream attempt.
 * @param {string} provider
 * @param {string} model
 * @param {number} requestStartTime - epoch ms
 * @param {Response|null} response
 * @param {{ isNetworkError?: boolean }} [options]
 */
export function recordUpstreamTelemetry(provider, model, requestStartTime, response = null, options = {}) {
  const { isNetworkError = false } = options;

  try {
    if (isNetworkError) {
      circuitBreaker.recordFailure(provider);
      providerReachability.recordUnreachable(provider);
    } else if (response) {
      const status = Number(response.status);
      if (status >= 500) {
        circuitBreaker.recordFailure(provider);
        providerReachability.recordUnreachable(provider);
      } else {
        circuitBreaker.recordSuccess(provider);
        providerReachability.recordReachable(provider);
      }
    }
  } catch {
    // Fail open
  }

  try {
    latencyStore.record(provider, model, Date.now() - requestStartTime);
  } catch {
    // Fail open
  }
}
