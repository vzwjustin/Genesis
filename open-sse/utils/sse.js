// Shared SSE helpers for executors that emit OpenAI-style chat.completion.chunk
// SSE streams. Kept dependency-free so it is safe to import from any executor
// without pulling in provider config or stream-pipeline code.

/** Serialize a chunk object as a single SSE `data:` line (with trailing blank line). */
export function sseChunk(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}
