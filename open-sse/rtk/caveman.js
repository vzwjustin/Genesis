// Caveman injector: appends a caveman-style instruction into the system message
// of the final request body, just before it is dispatched to the provider executor.
// Dispatches by format so it works for both translated and native-passthrough flows.

import { FORMATS } from "../translator/formats.js";
import { CAVEMAN_PROMPTS } from "./cavemanPrompts.js";

const SEP = "\n\n";

export function injectCaveman(body, format, level, provider = null) {
  const prompt = CAVEMAN_PROMPTS[level];
  if (!body || !prompt) return false;

  switch (format) {
    case FORMATS.CLAUDE:
      injectClaudeSystem(body, prompt, provider ?? "claude");
      return true;
    case FORMATS.GEMINI:
    case FORMATS.GEMINI_CLI:
    case FORMATS.VERTEX:
    case FORMATS.ANTIGRAVITY:
      // Antigravity wraps Gemini shape in body.request → injectGeminiSystem handles it
      injectGeminiSystem(body, prompt);
      return true;
    case FORMATS.OPENAI_RESPONSES:
      // Responses API: the system channel is the top-level `instructions` string.
      // Never push a Chat-shaped {type:"text"} part into input[] — input content
      // parts must be `input_text`, so a foreign type yields a 400 upstream.
      return injectResponsesInstructions(body, prompt);
    default:
      // OpenAI Chat and OpenAI-shaped formats (cursor/kiro/ollama)
      return injectMessagesSystem(body, prompt);
  }
}

// OpenAI Responses API: inject into the top-level `instructions` string. This is
// the canonical system-prompt channel and avoids mutating input[] with an
// invalid part type.
function injectResponsesInstructions(body, prompt) {
  body.instructions = typeof body.instructions === "string" && body.instructions
    ? `${body.instructions}${SEP}${prompt}`
    : prompt;
  return true;
}

// OpenAI-shaped: messages[] (chat) or input[] (responses) or instructions (responses string)
function injectMessagesSystem(body, prompt) {
  // OpenAI Responses API: top-level string field
  if (typeof body.instructions === "string") {
    body.instructions = body.instructions
      ? `${body.instructions}${SEP}${prompt}`
      : prompt;
    return true;
  }

  const arr = Array.isArray(body.messages) ? body.messages
    : Array.isArray(body.input) ? body.input
    : null;
  if (!arr) return false;

  const idx = arr.findIndex(m => m && (m.role === "system" || m.role === "developer"));
  if (idx >= 0) {
    // If the system message is large enough to be in OpenAI's prefix cache, insert a
    // separate system message after it rather than mutating it — preserves the cached prefix.
    if (mightBeOpenAICached(arr[idx])) {
      arr.splice(idx + 1, 0, { role: "system", content: prompt });
    } else {
      appendToOpenAIMessage(arr[idx], prompt);
    }
  } else {
    arr.unshift({ role: "system", content: prompt });
  }
  return true;
}

function appendToOpenAIMessage(msg, prompt) {
  if (typeof msg.content === "string") {
    msg.content = `${msg.content}${SEP}${prompt}`;
  } else if (Array.isArray(msg.content)) {
    msg.content.push({ type: "text", text: prompt });
  } else {
    msg.content = prompt;
  }
}

// Returns true if a system message looks like it may be hitting OpenAI's prefix cache
// (long enough to have been cached in a prior request — 1024 token threshold ≈ 4096 chars).
function mightBeOpenAICached(msg) {
  const MIN_CACHED_CHARS = 4096;
  if (typeof msg.content === "string") return msg.content.length >= MIN_CACHED_CHARS;
  if (Array.isArray(msg.content)) {
    const total = msg.content.reduce((s, p) => s + (p?.text?.length || p?.content?.length || 0), 0);
    return total >= MIN_CACHED_CHARS;
  }
  return false;
}

// Claude shape: body.system as string | array of {type:"text", text}
// Insert AFTER the last cache_control block so the cached prefix is never disturbed.
// Caveman is small (~100 tokens) so not caching it is negligible.
function injectClaudeSystem(body, prompt, provider = null) {
  if (typeof body.system === "string" && body.system.length > 0) {
    if (provider === "claude") {
      body.system = `${body.system}${SEP}${prompt}`;
    } else {
      body.system = [
        { type: "text", text: body.system },
        { type: "text", text: prompt },
      ];
    }
    return;
  }
  if (Array.isArray(body.system)) {
    const block = { type: "text", text: prompt };
    let lastCacheIdx = -1;
    for (let i = body.system.length - 1; i >= 0; i--) {
      if (body.system[i]?.cache_control) { lastCacheIdx = i; break; }
    }
    if (lastCacheIdx >= 0) {
      // Insert after the last cached block — cache prefix stays identical
      body.system.splice(lastCacheIdx + 1, 0, block);
    } else {
      body.system.push(block);
    }
    return;
  }
  body.system = prompt;
}

// Gemini shape: body.system_instruction | body.systemInstruction | body.request.systemInstruction
// Each shape: { parts: [{ text }] }
function pickGeminiSystemKey(target) {
  const snake = target.system_instruction;
  const camel = target.systemInstruction;
  const snakePopulated = snake && Array.isArray(snake.parts) && snake.parts.length > 0;
  const camelPopulated = camel && Array.isArray(camel.parts) && camel.parts.length > 0;
  if (snakePopulated) return "system_instruction";
  if (camelPopulated) return "systemInstruction";
  if (Object.prototype.hasOwnProperty.call(target, "system_instruction")) return "system_instruction";
  if (Object.prototype.hasOwnProperty.call(target, "systemInstruction")) return "systemInstruction";
  return "system_instruction";
}

function injectGeminiSystem(body, prompt) {
  const target = body.request && typeof body.request === "object" ? body.request : body;
  const key = pickGeminiSystemKey(target);
  const sys = target[key];
  if (sys && Array.isArray(sys.parts)) {
    sys.parts.push({ text: prompt });
    return;
  }
  target[key] = { parts: [{ text: prompt }] };
}
