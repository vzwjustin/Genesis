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
      if (response.ok || (status >= 400 && status < 500)) {
        circuitBreaker.recordSuccess(provider);
        providerReachability.recordReachable(provider);
      } else if (status >= 500) {
        circuitBreaker.recordFailure(provider);
        providerReachability.recordUnreachable(provider);
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
