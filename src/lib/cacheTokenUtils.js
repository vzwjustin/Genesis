/** Normalize provider cache token fields from usage/request token blobs. */
export function normalizeCacheTokens(tokens = {}) {
  const input = tokens.prompt_tokens || tokens.input_tokens || 0;
  const cacheRead = tokens.cached_tokens || tokens.cache_read_input_tokens || 0;
  const cacheCreate = tokens.cache_creation_input_tokens || 0;
  const output = tokens.completion_tokens || tokens.output_tokens || 0;
  const estimated = tokens.estimated === true;
  const hasCacheTelemetry = !estimated && (
    tokens.cache_read_input_tokens !== undefined
    || tokens.cache_creation_input_tokens !== undefined
    || tokens.cached_tokens !== undefined
  );
  return {
    input,
    output,
    cacheRead: Math.max(0, Number(cacheRead) || 0),
    cacheCreate: Math.max(0, Number(cacheCreate) || 0),
    estimated,
    hasCacheTelemetry,
    hasCache: (Number(cacheRead) || 0) > 0 || (Number(cacheCreate) || 0) > 0,
  };
}

/** Prompt-side tokens served from cache ÷ (read + fresh input + cache writes). */
export function computeTokenWeightedCacheHitRate({ cacheRead = 0, input = 0, cacheCreate = 0 } = {}) {
  const read = Math.max(0, Number(cacheRead) || 0);
  const fresh = Math.max(0, Number(input) || 0);
  const create = Math.max(0, Number(cacheCreate) || 0);
  const denominator = read + fresh + create;
  if (denominator <= 0) return 0;
  return Math.round((read / denominator) * 1000) / 10;
}
