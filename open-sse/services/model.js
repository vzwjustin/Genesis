import { resolveBareCodexModel } from "../utils/codexModel.js";

// Provider alias to ID mapping
const ALIAS_TO_PROVIDER_ID = {
  cc: "claude",
  cx: "codex",
  gc: "gemini-cli",
  qw: "qwen",
  if: "iflow",
  ag: "antigravity",
  gh: "github",
  kr: "kiro",
  cu: "cursor",
  kc: "kilocode",
  kmc: "kimi-coding",
  cl: "cline",
  oc: "opencode",
  ocg: "opencode-go",
  qd: "qoder",
  qoder: "qoder",
  // TTS providers
  el: "elevenlabs",
  // API Key providers
  openai: "openai",
  vercel: "vercel-ai-gateway",
  "vercel-ai-gateway": "vercel-ai-gateway",
  anthropic: "anthropic",
  gemini: "gemini",
  openrouter: "openrouter",
  glm: "glm",
  kimi: "kimi",
  minimax: "minimax",
  "minimax-cn": "minimax-cn",
  ds: "deepseek",
  deepseek: "deepseek",
  cmc: "commandcode",
  commandcode: "commandcode",
  groq: "groq",
  xai: "xai",
  mistral: "mistral",
  pplx: "perplexity",
  perplexity: "perplexity",
  together: "together",
  fireworks: "fireworks",
  cerebras: "cerebras",
  cohere: "cohere",
  nvidia: "nvidia",
  nebius: "nebius",
  siliconflow: "siliconflow",
  hyp: "hyperbolic",
  hyperbolic: "hyperbolic",
  dg: "deepgram",
  deepgram: "deepgram",
  aai: "assemblyai",
  assemblyai: "assemblyai",
  nb: "nanobanana",
  nanobanana: "nanobanana",
  ch: "chutes",
  chutes: "chutes",
  ark: "volcengine-ark",
  "volcengine-ark": "volcengine-ark",
  byteplus: "byteplus",
  bpm: "byteplus",
  cursor: "cursor",
  vx: "vertex",
  vertex: "vertex",
  vxp: "vertex-partner",
  "vertex-partner": "vertex-partner",
  // Web cookie providers
  gw: "grok-web",
  "grok-web": "grok-web",
  pw: "perplexity-web",
  "perplexity-web": "perplexity-web",
  mimo: "xiaomi-mimo",
  "xiaomi-mimo": "xiaomi-mimo",
  xmtp: "xiaomi-tokenplan",
  "xiaomi-tokenplan": "xiaomi-tokenplan",
  cf: "cloudflare-ai",
  "cloudflare-ai": "cloudflare-ai",
  // Image/video providers
  fal: "fal-ai",
  "fal-ai": "fal-ai",
  stability: "stability-ai",
  "stability-ai": "stability-ai",
  bfl: "black-forest-labs",
  "black-forest-labs": "black-forest-labs",
  recraft: "recraft",
  topaz: "topaz",
  runway: "runwayml",
  runwayml: "runwayml",
  // Embedding/rerank
  jina: "jina-ai",
  "jina-ai": "jina-ai",
  // TTS
  polly: "aws-polly",
  "aws-polly": "aws-polly",
  // Free-tier providers
  agentrouter: "agentrouter",
  aimlapi: "aimlapi",
  aiml: "aimlapi",
  novita: "novita",
  modal: "modal",
  mdl: "modal",
  reka: "reka",
  nlpcloud: "nlpcloud",
  nlpc: "nlpcloud",
  bazaarlink: "bazaarlink",
  bzl: "bazaarlink",
  completions: "completions",
  cpl: "completions",
  enally: "enally",
  enly: "enally",
  freetheai: "freetheai",
  fta: "freetheai",
  llm7: "llm7",
  lepton: "lepton",
  kluster: "kluster",
  ai21: "ai21",
  "inference-net": "inference-net",
  inet: "inference-net",
  predibase: "predibase",
  bytez: "bytez",
  morph: "morph",
  longcat: "longcat",
  lc: "longcat",
  puter: "puter",
  pu: "puter",
  uncloseai: "uncloseai",
  unc: "uncloseai",
  scaleway: "scaleway",
  scw: "scaleway",
  deepinfra: "deepinfra",
  sambanova: "sambanova",
  samba: "sambanova",
  nscale: "nscale",
  baseten: "baseten",
  publicai: "publicai",
  "nous-research": "nous-research",
  nous: "nous-research",
  glhf: "glhf",
  bb: "blackbox",
  blackbox: "blackbox",
};

/**
 * Resolve provider alias to provider ID
 */
export function resolveProviderAlias(aliasOrId) {
  return ALIAS_TO_PROVIDER_ID[aliasOrId] || aliasOrId;
}

/**
 * Parse model string into its component parts.
 *
 * Model strings can be in three formats:
 *   1. "provider/model" (e.g., "cc/claude-opus-4-6") — resolve provider alias to ID, return directly
 *   2. Plain string alias (e.g., "opus") — needs alias registry lookup
 *   3. Combo name (e.g., "primary-fallback") — needs combo expansion into ordered list
 *
 * This function handles format detection and provider alias resolution for format 1.
 * Formats 2 and 3 are both returned as isAlias:true — the distinction between alias
 * and combo is resolved at lookup time by the caller (see resolveModelAliasFromMap and
 * getComboModelsFromData).
 *
 * @param {string} modelStr - The raw model string from the request
 * @returns {{ provider: string|null, model: string|null, isAlias: boolean, providerAlias: string|null, original: string }}
 */
export function parseModel(modelStr) {
  if (!modelStr) {
    return { provider: null, model: null, isAlias: false, providerAlias: null, original: modelStr || "" };
  }

  // Format 1: "provider/model" or "alias/model" — resolve provider alias to ID and return directly
  if (modelStr.includes("/")) {
    const firstSlash = modelStr.indexOf("/");
    const providerOrAlias = modelStr.slice(0, firstSlash);
    const model = modelStr.slice(firstSlash + 1);
    const provider = resolveProviderAlias(providerOrAlias);
    return { provider, model, isAlias: false, providerAlias: providerOrAlias, original: modelStr };
  }

  // Format 2 or 3: plain string — could be a model alias or a combo name
  // The caller resolves which by checking the alias registry and combo registry
  return {
    provider: null,
    model: modelStr,
    isAlias: true,
    providerAlias: null,
    original: modelStr,
  };
}

/**
 * Resolve model alias from aliases object
 * Format: { "alias": "provider/model" }
 */
export function resolveModelAliasFromMap(alias, aliases) {
  if (!aliases) return null;

  // Check if alias exists
  const resolved = aliases[alias];
  if (!resolved) return null;

  // Resolved value is "provider/model" format
  if (typeof resolved === "string" && resolved.includes("/")) {
    const firstSlash = resolved.indexOf("/");
    const providerOrAlias = resolved.slice(0, firstSlash);
    return {
      provider: resolveProviderAlias(providerOrAlias),
      model: resolved.slice(firstSlash + 1),
    };
  }

  // Or object { provider, model }
  if (typeof resolved === "object" && resolved.provider && resolved.model) {
    return {
      provider: resolveProviderAlias(resolved.provider),
      model: resolved.model,
    };
  }

  return null;
}

/**
 * Get full model info (parse or resolve)
 * @param {string} modelStr - Model string
 * @param {object|function} aliasesOrGetter - Aliases object or async function to get aliases
 */
export async function getModelInfoCore(modelStr, aliasesOrGetter) {
  const parsed = parseModel(modelStr);

  if (!parsed.isAlias) {
    return {
      provider: parsed.provider,
      model: parsed.model,
    };
  }

  // Get aliases (from object or function)
  const aliases =
    typeof aliasesOrGetter === "function"
      ? await aliasesOrGetter()
      : aliasesOrGetter;

  // Resolve alias
  const resolved = resolveModelAliasFromMap(parsed.model, aliases);
  if (resolved) {
    return resolved;
  }

  const codexResolved = resolveBareCodexModel(parsed.model);
  if (codexResolved) {
    return codexResolved;
  }

  // Unresolved alias — fail closed (do not infer provider; callers must return HTTP 400)
  return {
    provider: null,
    model: parsed.model,
  };
}
