/**
 * Helpers for detecting <think>...</think> reasoning tags in a streamed text
 * delta sequence, where a single tag may straddle two chunks (e.g. "<thi"
 * arrives in one delta and "nk>" in the next).
 */

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

/**
 * Length of the longest suffix of `s` that is a proper (non-full) prefix of
 * either think tag. That suffix might be the start of a tag whose remainder
 * has not arrived yet, so the caller should hold it back until the next chunk.
 *
 * Returns 0 when no trailing partial tag is present (the common case).
 *
 * @param {string} s
 * @returns {number}
 */
export function trailingPartialTagLen(s) {
  if (!s) return 0;
  // A held-back fragment is at most one char short of the longest tag.
  const max = Math.min(s.length, THINK_CLOSE.length - 1);
  for (let len = max; len > 0; len--) {
    const suffix = s.slice(s.length - len);
    if (THINK_OPEN.startsWith(suffix) || THINK_CLOSE.startsWith(suffix)) {
      return len;
    }
  }
  return 0;
}
