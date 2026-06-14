// Request latency metrics — in-memory ring buffer per provider-model pair
// Records upstream request durations and computes percentile aggregations.
//
// record() never throws. Errors are caught and swallowed.
// getStats() computes aggregations synchronously by sorting in O(n log n).
// Old samples are evicted FIFO when capacity is reached.

/**
 * Parse LATENCY_BUFFER_SIZE env var within [100, 100000], falling back to 1000 with a warning.
 */
function parseBufferSize() {
  const raw = process.env.LATENCY_BUFFER_SIZE;
  if (raw === undefined || raw === "") return 1000;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 100 || parsed > 100000) {
    console.warn(
      `[LatencyMetrics] Invalid LATENCY_BUFFER_SIZE="${raw}" (must be integer 100–100000), using default 1000`
    );
    return 1000;
  }
  return parsed;
}

/**
 * Compute the value at a given percentile using nearest-rank method.
 * @param {number[]} sorted - sorted array of samples
 * @param {number} percentile - percentile (0–100)
 * @returns {number}
 */
function nearestRank(sorted, percentile) {
  const rank = Math.ceil((percentile / 100) * sorted.length);
  return sorted[Math.max(0, rank - 1)];
}

/**
 * Factory: creates a latency store instance with the given options.
 * @param {{ bufferSize?: number }} [options]
 * @returns {{ record: (provider: string, model: string, durationMs: number) => void, getStats: () => Record<string, Record<string, {p50: number, p95: number, avg: number, count: number}>> }}
 */
export function createLatencyStore(options = {}) {
  const bufferSize = options.bufferSize ?? parseBufferSize();

  /**
   * @type {Map<string, { samples: number[], head: number, count: number }>}
   * Key format: "provider\0model"
   */
  const buffers = new Map();

  /**
   * Get or create a ring buffer for a provider-model pair.
   */
  function getOrCreate(provider, model) {
    const key = provider + "\0" + model;
    let buf = buffers.get(key);
    if (!buf) {
      buf = { samples: new Array(bufferSize), head: 0, count: 0 };
      buffers.set(key, buf);
    }
    return buf;
  }

  /**
   * Record a latency sample. Never throws.
   * @param {string} provider
   * @param {string} model
   * @param {number} durationMs
   */
  function record(provider, model, durationMs) {
    try {
      const buf = getOrCreate(provider, model);
      buf.samples[buf.head] = Math.floor(durationMs);
      buf.head = (buf.head + 1) % bufferSize;
      if (buf.count < bufferSize) {
        buf.count += 1;
      }
    } catch {
      // Never throw — errors swallowed silently
    }
  }

  /**
   * Compute aggregated statistics for all provider-model pairs.
   * @returns {Record<string, Record<string, {p50: number, p95: number, avg: number, count: number}>>}
   */
  function getStats() {
    try {
      const result = {};

      for (const [key, buf] of buffers) {
        if (buf.count === 0) continue;

        const sepIdx = key.indexOf("\0");
        const provider = key.slice(0, sepIdx);
        const model = key.slice(sepIdx + 1);

        // Extract active samples and sort
        const active = buf.samples.slice(0, buf.count);
        active.sort((a, b) => a - b);

        const sum = active.reduce((acc, v) => acc + v, 0);

        const stats = {
          p50: nearestRank(active, 50),
          p95: nearestRank(active, 95),
          avg: Math.floor(sum / active.length),
          count: active.length,
        };

        if (!result[provider]) {
          result[provider] = {};
        }
        result[provider][model] = stats;
      }

      return result;
    } catch {
      return {};
    }
  }

  return { record, getStats };
}

/** Singleton latency store configured from environment variables */
export const latencyStore = createLatencyStore();
