const { MODEL_SYNONYMS, MODEL_PATTERNS } = require("./config");
const { getMitmAlias } = require("./dbReader");

/** Strip qdev:: (and similar) namespace prefixes from Kiro model identifiers. */
function normalizeKiroModelId(model) {
  if (model == null) return null;
  const s = String(model).trim();
  if (!s) return null;
  const idx = s.indexOf("::");
  if (idx !== -1) {
    const id = s.slice(idx + 2).trim();
    return id || s;
  }
  return s;
}

const CURSOR_PROVIDER_PREFIX_RE = /^(?:cu|cursor)\//i;

/** Strip 9router provider prefixes from Cursor protobuf model ids (cu/gpt-5.5-high → gpt-5.5-high). */
function normalizeCursorModelId(model) {
  if (model == null) return null;
  let s = String(model).trim();
  if (!s) return null;
  for (let i = 0; i < 4 && CURSOR_PROVIDER_PREFIX_RE.test(s); i++) {
    s = s.replace(CURSOR_PROVIDER_PREFIX_RE, "");
  }
  return s || null;
}

/** True when id looks like a native Cursor upstream slug (not garbage / prefixed routes). */
function isLikelyCursorNativeModelId(modelId) {
  if (!modelId || typeof modelId !== "string") return false;
  const s = modelId.trim();
  if (!s || s.includes("/")) return false;
  return /^(auto|default|composer|claude|gpt|grok|kimi)/i.test(s);
}

function cursorRouteForAliasKey(aliasKey, aliases) {
  if (!aliasKey) return null;
  if (aliases?.[aliasKey]) return aliases[aliasKey];
  if (isLikelyCursorNativeModelId(aliasKey)) return `cu/${aliasKey}`;
  return null;
}

// Extract model from URL path (Gemini), body (OpenAI/Anthropic), or Kiro conversationState
function extractModel(url, body) {
  const urlMatch = url.match(/\/models\/([^/:]+)/);
  if (urlMatch) return urlMatch[1];
  try {
    const parsed = JSON.parse(body.toString());
    if (parsed.conversationState) {
      const cs = parsed.conversationState;
      const fromCurrent = cs.currentMessage?.userInputMessage?.modelId;
      if (fromCurrent && String(fromCurrent).trim()) {
        return normalizeKiroModelId(fromCurrent) || String(fromCurrent).trim();
      }
      // Follow-up turns (especially after tool rounds) often omit modelId on currentMessage
      const history = cs.history || [];
      for (let i = history.length - 1; i >= 0; i--) {
        const id = history[i]?.userInputMessage?.modelId;
        if (id && String(id).trim()) {
          return normalizeKiroModelId(id) || String(id).trim();
        }
      }
      // agentModelSelection "auto" — Kiro omits modelId when modelType is unset
      return "auto";
    }
    return parsed.model || null;
  } catch {
    return null;
  }
}

function getKiroFallbackAlias(aliases) {
  if (!aliases) return null;
  if (aliases["claude-sonnet-4.6"]) return aliases["claude-sonnet-4.6"];
  if (aliases["claude-sonnet-4.5"]) return aliases["claude-sonnet-4.5"];
  const first = Object.values(aliases).find(Boolean);
  return first || null;
}

function getCursorFallbackAlias(aliases) {
  if (!aliases) return null;
  if (aliases["composer-2.5-fast"]) return aliases["composer-2.5-fast"];
  if (aliases.auto) return aliases.auto;
  return Object.values(aliases).find(Boolean) || null;
}

function getMappedModel(tool, model) {
  const aliases = getMitmAlias(tool);
  if (!aliases) return null;

  let lookup = model;
  if (tool === "kiro") {
    lookup = normalizeKiroModelId(model) || (model ? String(model).trim() : null) || "auto";
  } else if (tool === "cursor") {
    lookup = normalizeCursorModelId(model) || "auto";
  } else if (!lookup) {
    return null;
  }

  lookup = MODEL_SYNONYMS?.[tool]?.[lookup] || lookup;
  if (aliases[lookup]) return aliases[lookup];

  // Only match keys that are a prefix OF the lookup (lookup.startsWith(k)),
  // never the reverse — `k.startsWith(lookup)` let a short/partial id like
  // "claude" greedily match an unrelated longer key and rewrite to the wrong
  // model. Among valid prefixes, pick the longest (most specific) match.
  const prefixKey = Object.keys(aliases)
    .filter(k => k && aliases[k] && lookup.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  if (prefixKey) return aliases[prefixKey];

  const patterns = MODEL_PATTERNS?.[tool] || [];
  for (const { match, alias } of patterns) {
    if (!match.test(lookup)) continue;
    if (tool === "cursor") {
      const routed = cursorRouteForAliasKey(alias, aliases);
      if (routed) return routed;
    } else if (aliases[alias]) {
      return aliases[alias];
    }
  }

  if (tool === "cursor") {
    const direct = cursorRouteForAliasKey(lookup, aliases);
    if (direct) return direct;
  }

  if (tool === "kiro") return getKiroFallbackAlias(aliases);
  if (tool === "cursor") return getCursorFallbackAlias(aliases);
  return null;
}

module.exports = {
  extractModel,
  getMappedModel,
  normalizeKiroModelId,
  normalizeCursorModelId,
  isLikelyCursorNativeModelId,
  getKiroFallbackAlias,
  getCursorFallbackAlias,
};
