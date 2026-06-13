import { createRequire } from "module";
import { FORMATS } from "./formats.js";
import { ensureToolCallIds, fixMissingToolResponses } from "./helpers/toolCallHelper.js";
import { prepareClaudeRequest, hasAnthropicCacheBreakpoints } from "./helpers/claudeHelper.js";
import { cloakClaudeTools } from "../utils/claudeCloaking.js";
import { filterToOpenAIFormat } from "./helpers/openaiHelper.js";
import { normalizeThinkingConfig } from "../services/provider.js";
import { AntigravityExecutor } from "../executors/antigravity.js";

const require = createRequire(import.meta.url);

// Registry for translators
const requestRegistry = new Map();
const responseRegistry = new Map();

// Track initialization state
let initialized = false;

// Register translator
export function register(from, to, requestFn, responseFn) {
  const key = `${from}:${to}`;
  if (requestFn) {
    requestRegistry.set(key, requestFn);
  }
  if (responseFn) {
    responseRegistry.set(key, responseFn);
  }
}

// Lazy load translators (called once on first use)
function ensureInitialized() {
  if (initialized) return;
  initialized = true;

  // Request translators - sync require pattern for bundler
  require("./request/claude-to-openai.js");
  require("./request/openai-to-claude.js");
  require("./request/gemini-to-openai.js");
  require("./request/openai-to-gemini.js");
  require("./request/openai-to-vertex.js");
  require("./request/antigravity-to-openai.js");
  require("./request/openai-responses.js");
  require("./request/openai-to-kiro.js");
  require("./request/openai-to-cursor.js");
  require("./request/openai-to-ollama.js");
  require("./request/openai-to-commandcode.js");

  // Response translators
  require("./response/claude-to-openai.js");
  require("./response/openai-to-claude.js");
  require("./response/gemini-to-openai.js");
  require("./response/openai-to-gemini.js");
  require("./response/openai-to-antigravity.js");
  require("./response/openai-responses.js");
  require("./response/kiro-to-openai.js");
  require("./response/cursor-to-openai.js");
  require("./response/ollama-to-openai.js");
  require("./response/commandcode-to-openai.js");
}

// Strip specific content types from messages (explicit opt-in via strip[] in PROVIDER_MODELS)
function stripContentTypes(body, stripList = []) {
  if (!stripList.length || !body.messages || !Array.isArray(body.messages)) return;
  const imageTypes = new Set(["image_url", "image"]);
  const audioTypes = new Set(["audio_url", "input_audio"]);
  const shouldStrip = (type) => {
    if (imageTypes.has(type)) return stripList.includes("image");
    if (audioTypes.has(type)) return stripList.includes("audio");
    return false;
  };
  for (const msg of body.messages) {
    if (!Array.isArray(msg.content)) continue;
    msg.content = msg.content.filter(part => !shouldStrip(part.type));
    if (msg.content.length === 0) msg.content = "";
  }
}

// Translate request: source -> openai -> target
export function translateRequest(sourceFormat, targetFormat, model, body, stream = true, credentials = null, provider = null, reqLogger = null, stripList = [], connectionId = null, clientTool = null) {
  ensureInitialized();
  let result = structuredClone(body);
  const clientOwnsCacheLayout = hasAnthropicCacheBreakpoints(body);

  if (clientOwnsCacheLayout && sourceFormat !== targetFormat) {
    const err = new Error(
      "Cannot translate across formats when the client placed Anthropic cache_control breakpoints"
    );
    err.code = "cache_translation_forbidden";
    throw err;
  }

  if (!clientOwnsCacheLayout) {
    // Strip explicit content types (opt-in via strip[] in PROVIDER_MODELS entry)
    stripContentTypes(result, stripList);

    // Normalize thinking config: remove if lastMessage is not user
    normalizeThinkingConfig(result);

    // Always ensure tool_calls have id (some providers require it)
    ensureToolCallIds(result);

    // Fix missing tool responses (insert empty tool_result if needed)
    fixMissingToolResponses(result);
  }

  // If same format, skip translation steps
  if (sourceFormat !== targetFormat) {
    // Step 1: source -> openai (if source is not openai)
    if (sourceFormat !== FORMATS.OPENAI) {
      const toOpenAIKey = `${sourceFormat}:${FORMATS.OPENAI}`;
      const toOpenAI = requestRegistry.get(toOpenAIKey);
      if (!toOpenAI) {
        throw new Error(`No request translator registered for ${toOpenAIKey}`);
      }
      result = toOpenAI(model, result, stream, credentials);
      reqLogger?.logOpenAIRequest?.(result);
    }

    // Step 2: openai -> target (if target is not openai)
    if (targetFormat !== FORMATS.OPENAI) {
      const fromOpenAIKey = `${FORMATS.OPENAI}:${targetFormat}`;
      const fromOpenAI = requestRegistry.get(fromOpenAIKey);
      if (!fromOpenAI) {
        throw new Error(`No request translator registered for ${fromOpenAIKey}`);
      }
      result = fromOpenAI(model, result, stream, credentials);
    }
  }

  // Always normalize to clean OpenAI format when target is OpenAI
  // This handles hybrid requests (e.g., OpenAI messages + Claude tools)
  if (targetFormat === FORMATS.OPENAI && !hasAnthropicCacheBreakpoints(result)) {
    result = filterToOpenAIFormat(result);
  }

  // Final step: prepare request for Claude format endpoints
  if (targetFormat === FORMATS.CLAUDE) {
    const apiKey = credentials?.accessToken || credentials?.apiKey || null;
    result = prepareClaudeRequest(result, provider, apiKey, connectionId, credentials?._requestHeaders);
  }

  // Claude cloaking: rename client tools with _cc suffix (anti-ban)
  // Only for claude provider (not anthropic-compatible-*) with OAuth token
  if (provider === "claude") {
    const apiKey = credentials?.accessToken || credentials?.apiKey || null;
    // Tool renaming injects decoys and shifts tool cache breakpoints — skip when the
    // client already placed cache_control markers we must preserve byte-for-byte.
    if (apiKey?.includes("sk-ant-oat") && !hasAnthropicCacheBreakpoints(result)) {
      const { body: cloakedBody, toolNameMap } = cloakClaudeTools(result);
      result = cloakedBody;
      if (toolNameMap?.size > 0) {
        result._toolNameMap = toolNameMap;
      }
    }
  }

  // Antigravity cloaking disabled
  // if (provider === FORMATS.ANTIGRAVITY && body.userAgent !== FORMATS.ANTIGRAVITY) {
  //   const { cloakedBody, toolNameMap } = AntigravityExecutor.cloakTools(result);
  //   result = cloakedBody;
  //   if (toolNameMap?.size > 0) {
  //     result._toolNameMap = toolNameMap;
  //   }
  // }

  return result;
}

// Translate response chunk: target -> openai -> source
export function translateResponse(targetFormat, sourceFormat, chunk, state) {
  ensureInitialized();
  // If same format, return as-is
  if (sourceFormat === targetFormat) {
    return [chunk];
  }

  let results = [chunk];
  let openaiResults = null; // Store OpenAI intermediate results

  // Step 1: target -> openai (if target is not openai)
  if (targetFormat !== FORMATS.OPENAI) {
    const toOpenAI = responseRegistry.get(`${targetFormat}:${FORMATS.OPENAI}`);
    if (toOpenAI) {
      results = [];
      const converted = toOpenAI(chunk, state);
      if (converted) {
        results = Array.isArray(converted) ? converted : [converted];
        openaiResults = results; // Store OpenAI intermediate
      }
    }
  }

  // Step 2: openai -> source (if source is not openai)
  if (sourceFormat !== FORMATS.OPENAI) {
    const fromOpenAI = responseRegistry.get(`${FORMATS.OPENAI}:${sourceFormat}`);
    if (fromOpenAI) {
      const finalResults = [];
      for (const r of results) {
        const converted = fromOpenAI(r, state);
        if (converted) {
          finalResults.push(...(Array.isArray(converted) ? converted : [converted]));
        }
      }
      // When chunk is null (flush), also flush step 2 if step 1 produced no output.
      // This ensures the step-2 translator can emit any buffered content (e.g. tool args).
      if (chunk === null && results.length === 0) {
        const flushed = fromOpenAI(null, state);
        if (flushed) {
          finalResults.push(...(Array.isArray(flushed) ? flushed : [flushed]));
        }
      }
      results = finalResults;
    }
  }

  // Attach OpenAI intermediate results for logging
  if (openaiResults && sourceFormat !== FORMATS.OPENAI && targetFormat !== FORMATS.OPENAI) {
    results._openaiIntermediate = openaiResults;
  }

  return results;
}

// Check if translation needed
export function needsTranslation(sourceFormat, targetFormat) {
  return sourceFormat !== targetFormat;
}

// Initialize state for streaming response based on format
export function initState(sourceFormat) {
  // Base state for all formats
  const base = {
    messageId: null,
    model: null,
    textBlockStarted: false,
    thinkingBlockStarted: false,
    inThinkingBlock: false,
    currentBlockIndex: null,
    toolCalls: new Map(),
    finishReason: null,
    finishReasonSent: false,
    usage: null,
    contentBlockIndex: -1
  };

  // Add openai-responses specific fields
  if (sourceFormat === FORMATS.OPENAI_RESPONSES) {
    return {
      ...base,
      seq: 0,
      responseId: `resp_${Date.now()}`,
      created: Math.floor(Date.now() / 1000),
      started: false,
      msgTextBuf: {},
      msgItemAdded: {},
      msgContentAdded: {},
      msgItemDone: {},
      reasoningId: "",
      reasoningIndex: -1,
      reasoningBuf: "",
      reasoningPartAdded: false,
      reasoningDone: false,
      inThinking: false,
      funcArgsBuf: {},
      funcNames: {},
      funcCallIds: {},
      funcArgsDone: {},
      funcItemDone: {},
      completedSent: false
    };
  }

  return base;
}

// Initialize all translators (kept for backward compatibility)
export function initTranslators() {
  ensureInitialized();
}
