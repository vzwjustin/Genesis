/** Normalize provider cache token fields from usage/request token blobs. */
export function normalizeCacheTokens(tokens = {}) {
  const input = tokens.prompt_tokens || tokens.input_tokens || 0;
  const cacheRead = tokens.cached_tokens || tokens.cache_read_input_tokens || 0;
  const cacheCreate = tokens.cache_creation_input_tokens || 0;
  const output = tokens.completion_tokens || tokens.output_tokens || 0;
  return {
    input,
    output,
    cacheRead: Math.max(0, Number(cacheRead) || 0),
    cacheCreate: Math.max(0, Number(cacheCreate) || 0),
    hasCache: (Number(cacheRead) || 0) > 0 || (Number(cacheCreate) || 0) > 0,
  };
}
