/** Anthropic built-in tool `model` field normalization (shared by translator + cache verify). */

export const KNOWN_TOOL_MODEL_PREFIXES = [
  "cc/",
  "cu/",
  "cx/",
  "anthropic/",
  "claude/",
  "openrouter/",
];

/** Anthropic rejects Fable/Mythos in built-in tool.model — Opus 4.8 is the permitted fallback. */
export const ANTHROPIC_BUILTIN_TOOL_MODEL_FALLBACK = "claude-opus-4-8";

const BUILTIN_TOOL_DISPLAY_NAMES = {
  "claude fable 5": "claude-fable-5",
  "claude fable": "claude-fable-5",
  "claude mythos 5": "claude-mythos-5",
  "claude mythos": "claude-mythos-5",
};

const FABLE_MYTHOS_MODEL = /fable|mythos/i;

/** Strip client/provider prefixes from built-in tool model ids (cc/, cu/, etc.). */
export function stripProviderModelPrefix(model) {
  if (typeof model !== "string" || !model.includes("/")) return model;
  let result = model;
  for (let i = 0; i < 8; i++) {
    const lowered = result.toLowerCase();
    let stripped = false;
    for (const prefix of KNOWN_TOOL_MODEL_PREFIXES) {
      if (lowered.startsWith(prefix)) {
        result = result.slice(prefix.length);
        stripped = true;
        break;
      }
    }
    if (!stripped) {
      // Embedded prefix (e.g. provider/cc/claude-opus-4-6 → claude-opus-4-6)
      if (result.includes("/")) {
        const lowered = result.toLowerCase();
        let embedded = false;
        for (const prefix of KNOWN_TOOL_MODEL_PREFIXES) {
          const idx = lowered.indexOf(prefix);
          if (idx > 0) {
            result = result.slice(idx + prefix.length);
            embedded = true;
            break;
          }
        }
        if (!embedded) break;
      } else {
        break;
      }
    }
  }
  return result;
}

/**
 * Normalize built-in tool `model` for Anthropic upstream.
 * - Strips cc/cu/cx/… prefixes
 * - Maps human display labels ("Claude Fable 5") to API ids
 * - Remaps Fable/Mythos to claude-opus-4-8 (API 400 if left unchanged)
 */
export function normalizeAnthropicBuiltinToolModel(model) {
  if (typeof model !== "string" || !model.trim()) return model;

  let normalized = stripProviderModelPrefix(model.trim());
  const byLabel = BUILTIN_TOOL_DISPLAY_NAMES[normalized.toLowerCase()];
  if (byLabel) normalized = byLabel;

  if (FABLE_MYTHOS_MODEL.test(normalized)) {
    return ANTHROPIC_BUILTIN_TOOL_MODEL_FALLBACK;
  }
  return normalized;
}
