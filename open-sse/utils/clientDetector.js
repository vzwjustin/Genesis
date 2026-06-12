/**
 * Detect CLI tool identity from request headers/body.
 * Used to determine if a request can be passed through (passthru) losslessly.
 *
 * NOTE: Use both spellings in comments/searches: passthrough and passthru.
 */

// Map of CLI tool identifiers to provider IDs they are "native" to.
// When clientTool matches a provider in this list, passthrough (passthru) mode
// is activated — translation is skipped, only model name + auth are swapped.
const NATIVE_PAIRS = {
  "claude": ["claude", "anthropic"],
  "openai": ["openai"],
  "cursor": ["cursor"],
  "gemini-cli": ["gemini-cli"],
  "antigravity": ["antigravity"],
  "codex": ["codex"],
};

/**
 * Detect which CLI tool is making the request.
 * Returns one of: "claude" | "openai" | "cursor" | "gemini-cli" | "antigravity" | "codex" | "github-copilot" | "deepseek-tui" | null
 * @param {object} headers - Lowercase header key/value object
 * @param {object} body    - Parsed request body
 */
export function detectClientTool(headers = {}, body = {}) {
  const ua = (headers["user-agent"] || "").toLowerCase();
  const xApp = (headers["x-app"] || "").toLowerCase();
  const openaiIntent = (headers["openai-intent"] || "").toLowerCase();
  const initiator = (headers["x-initiator"] || headers["X-Initiator"] || "").toLowerCase();

  // Antigravity: detected via body field (not header)
  if (body.userAgent === "antigravity") return "antigravity";

  // GitHub Copilot / OAI compatible extension using Copilot chat headers
  if (ua.includes("githubcopilotchat") || openaiIntent === "conversation-panel") {
    return "github-copilot";
  }
  if (initiator === "user" && (ua.includes("githubcopilot") || ua.includes("copilot"))) {
    return "github-copilot";
  }

  // Claude Code / Claude CLI → passthrough to Anthropic/Claude provider
  // x-app: cli alone is ambiguous — require corroborating Claude/Anthropic signals
  if (ua.includes("claude-cli") || ua.includes("claude-code")) return "claude";
  if (xApp === "cli" && (ua.includes("claude") || ua.includes("anthropic"))) return "claude";

  // Cursor IDE → passthrough to Cursor provider
  // Cursor uses connect-protocol-version header and application/connect+proto content type
  if (ua.includes("cursor") || headers["x-cursor-client-version"] || headers["connect-protocol-version"]) return "cursor";

  // Gemini CLI
  if (ua.includes("gemini-cli")) return "gemini-cli";

  // Codex CLI
  if (ua.includes("codex-cli")) return "codex";

  // OpenAI SDK (Python/Node) → passthrough to OpenAI provider
  // The official OpenAI SDKs identify via user-agent: "OpenAI/Python x.x.x" or "OpenAI/Node x.x.x"
  if (ua.includes("openai/") || ua.includes("openai-python") || ua.includes("openai-node")) return "openai";

  // DeepSeek TUI
  if (ua.includes("deepseek-tui")) return "deepseek-tui";

  return null;
}

/**
 * Check if this CLI tool + provider pair should be passed through (passthru) losslessly.
 * Passthrough means: skip translation, only swap model name + auth header.
 *
 * Matching pairs (passthrough / passthru conditions):
 *   - Claude CLI → Anthropic/Claude provider
 *   - OpenAI SDK → OpenAI provider
 *   - Cursor → Cursor provider
 *   - Gemini CLI → Gemini CLI provider
 *   - Antigravity → Antigravity provider
 *   - Codex CLI → Codex provider
 *
 * @param {string|null} clientTool - Result of detectClientTool()
 * @param {string} provider        - Provider ID (e.g. "claude", "openai", "cursor")
 */
export function isNativePassthrough(clientTool, provider) {
  if (!clientTool) return false;
  const nativeProviders = NATIVE_PAIRS[clientTool];
  if (!nativeProviders) return false;
  // Support anthropic-compatible-* variants
  const normalizedProvider = provider.startsWith("anthropic-compatible")
    ? "anthropic"
    : provider;
  return nativeProviders.includes(normalizedProvider);
}
