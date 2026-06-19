/**
 * Shared wire-type classifier for Provider_Model_String values.
 *
 * Single source of truth so the OpenCode config-writer (narrow family) and the
 * Kiro IDE config-writer (broad family) agree on Anthropic- vs OpenAI-wire
 * classification. AGENTS.md forbids duplicated divergent rules.
 *
 * The "narrow" prefix set is byte-identical to the OpenCode writer's existing
 * `/^(cc\/|claude[-/])/i` regex — no behavior change for existing OpenCode
 * classification. The "broad" set adds the Kiro Claude-compatible prefixes.
 */

/** Anthropic-wire prefix regex per family. */
export const ANTHROPIC_WIRE_PREFIXES = {
  // OpenCode (Requirements 3.2/3.3): cc/ + claude-/claude/ only.
  narrow: /^(cc\/|claude[-/])/i,
  // Kiro (Requirements 4.2/4.3): adds kr/, kimi/, glm/, minimax/.
  broad: /^(cc\/|kr\/|kimi\/|glm\/|minimax\/|claude[-/])/i,
};

/**
 * Classify a Provider_Model_String as Anthropic-wire or OpenAI-wire.
 *
 * @param {string} providerModelString - e.g. "cc/claude-opus-4-8", "cx/gpt-5.4".
 * @param {{ family?: "narrow" | "broad" }} [options] - prefix set to use;
 *   defaults to "narrow" to preserve existing OpenCode behavior.
 * @returns {"anthropic" | "openai"}
 */
export function getWireType(providerModelString, { family = "narrow" } = {}) {
  const regex = ANTHROPIC_WIRE_PREFIXES[family] || ANTHROPIC_WIRE_PREFIXES.narrow;
  if (typeof providerModelString === "string" && regex.test(providerModelString)) {
    return "anthropic";
  }
  return "openai";
}
