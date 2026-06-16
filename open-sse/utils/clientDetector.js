import { MITM_PROXY_HEADER } from "../config/appConstants.js";
import { detectFormat, getTargetFormat } from "../services/provider.js";
import { detectFormatByEndpoint, FORMATS } from "../translator/formats.js";

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
  // MITM already decoded Cursor ConnectRPC → OpenAI JSON; do not treat as native cursor client.
  if (headers[MITM_PROXY_HEADER.name] === MITM_PROXY_HEADER.value) return null;

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
  // Support anthropic-compatible-* variants. Use optional chaining: a null/undefined
  // provider must fail closed (no passthrough) rather than throw a TypeError here.
  const normalizedProvider = provider?.startsWith("anthropic-compatible")
    ? "anthropic"
    : provider;
  return nativeProviders.includes(normalizedProvider);
}

function isClaudeProvider(provider) {
  return provider === "claude" || provider?.startsWith("anthropic-compatible");
}

/**
 * Claude-shaped request to a Claude provider on /v1/messages — skip translation so
 * OAuth billing headers and client cache_control breakpoints stay byte-identical.
 */
function isFormatAlignedClaudePassthrough(provider, { body, headers = {}, pathname = "" } = {}) {
  if (!isClaudeProvider(provider)) return false;
  const sourceFormat =
    (pathname && detectFormatByEndpoint(pathname, body))
    || detectFormat(body, headers);
  const targetFormat = getTargetFormat(provider);
  return sourceFormat === FORMATS.CLAUDE && targetFormat === FORMATS.CLAUDE;
}

/**
 * Native passthrough only when the request body matches the provider wire format.
 * Cursor MITM and /v1/chat/completions submit OpenAI JSON — must use transformRequest.
 */
export function shouldUseNativePassthrough(clientTool, provider, { body, headers = {}, pathname = "" } = {}) {
  if (isNativePassthrough(clientTool, provider)) {
    if (provider === "cursor") {
      const contentType = String(headers["content-type"] || headers["Content-Type"] || "").toLowerCase();
      const isConnectProto = contentType.includes("application/connect");
      if (!isConnectProto && !Buffer.isBuffer(body)) return false;
    }
    return true;
  }
  return isFormatAlignedClaudePassthrough(provider, { body, headers, pathname });
}
