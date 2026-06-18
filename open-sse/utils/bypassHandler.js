import { detectFormat } from "../services/provider.js";
import { translateResponse, initState } from "../translator/index.js";
import { FORMATS } from "../translator/formats.js";
import { SKIP_PATTERNS } from "../config/runtimeConfig.js";
import { formatSSE } from "./stream.js";

/**
 * Check for bypass patterns - return fake response without calling provider
 * Only works for Claude CLI requests
 */
export function handleBypassRequest(body, model, userAgent = "", ccFilterNaming = false) {
  if (!userAgent.includes("claude-cli")) return null;
  if (!body.messages?.length) return null;

  const messages = body.messages;
  const getText = (content) => {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.filter(c => c.type === "text").map(c => c.text).join(" ");
    }
    return "";
  };

  let shouldBypass = false;
  let namingBypass = false;

  // Pattern 1: Title extraction (assistant message = "{")
  const lastMsg = messages[messages.length - 1];
  if (lastMsg?.role === "assistant" && lastMsg.content?.[0]?.text === "{") {
    shouldBypass = true;
  }

  // Pattern 2: Warmup
  if (!shouldBypass) {
    const firstText = getText(messages[0]?.content);
    if (firstText === "Warmup") {
      shouldBypass = true;
    }
  }

  // Pattern 3: Count
  if (!shouldBypass && messages.length === 1 && messages[0]?.role === "user") {
    const firstText = getText(messages[0]?.content);
    if (firstText === "count") {
      shouldBypass = true;
    }
  }

  // Pattern 4: Skip patterns
  if (!shouldBypass && SKIP_PATTERNS?.length) {
    const userMessages = messages.filter(m => m.role === "user");
    const userText = userMessages.map(m => getText(m.content)).join(" ");
    if (SKIP_PATTERNS.some(p => userText.includes(p))) {
      shouldBypass = true;
    }
  }

  // Pattern 5: CC naming request (topic title extraction by Claude Code CLI)
  // Claude format: system is top-level body.system field, not inside messages
  if (!shouldBypass && ccFilterNaming) {
    const systemMsg = messages.find(m => m.role === "system");
    const systemFromMessages = getText(systemMsg?.content);
    const systemFromBody = Array.isArray(body.system)
      ? body.system.filter(s => s.type === "text").map(s => s.text).join(" ")
      : (typeof body.system === "string" ? body.system : "");
    const systemText = systemFromMessages || systemFromBody;
    if (systemText.includes("isNewTopic")) {
      shouldBypass = true;
      namingBypass = true;
    }
  }

  if (!shouldBypass) return null;

  const sourceFormat = detectFormat(body);
  const stream = body.stream !== false;

  // For naming bypass, generate title from user message
  if (namingBypass) {
    const userMsg = messages.find(m => m.role === "user");
    const userText = getText(userMsg?.content);
    const title = userText.trim().split(/\s+/).slice(0, 3).join(" ");
    const namingText = JSON.stringify({ isNewTopic: true, title });
    return stream
      ? createStreamingResponse(sourceFormat, model, namingText)
      : createNonStreamingResponse(sourceFormat, model, namingText);
  }

  return stream 
    ? createStreamingResponse(sourceFormat, model)
    : createNonStreamingResponse(sourceFormat, model);
}

const DEFAULT_BYPASS_TEXT = "CLI Command Execution: Clear Terminal";

/**
 * Create OpenAI standard format response
 */
function createOpenAIResponse(model, text = DEFAULT_BYPASS_TEXT) {
  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: text
      },
      finish_reason: "stop"
    }],
    usage: {
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2
    }
  };
}

/**
 * Create non-streaming response with translation
 * Use translator to convert OpenAI → sourceFormat
 */
function createNonStreamingResponse(sourceFormat, model, text) {
  const openaiResponse = createOpenAIResponse(model, text);

  // If sourceFormat is OpenAI, return directly
  if (sourceFormat === FORMATS.OPENAI) {
    return {
      success: true,
      response: new Response(JSON.stringify(openaiResponse), {
        // No Access-Control-Allow-Origin: these synthesized responses are only
        // served to the claude-cli UA (CLI clients don't enforce CORS). A
        // wildcard would let any web page the user visits read them cross-origin.
        headers: {
          "Content-Type": "application/json"
        }
      })
    };
  }

  // Use translator to convert: simulate streaming then collect all chunks
  const state = initState(sourceFormat);
  state.model = model;

  const openaiChunks = createOpenAIStreamingChunks(openaiResponse);
  const allTranslated = [];

  for (const chunk of openaiChunks) {
    const translated = translateResponse(FORMATS.OPENAI, sourceFormat, chunk, state);
    if (translated?.length > 0) {
      allTranslated.push(...translated);
    }
  }

  // Flush remaining
  const flushed = translateResponse(FORMATS.OPENAI, sourceFormat, null, state);
  if (flushed?.length > 0) {
    allTranslated.push(...flushed);
  }

  // For non-streaming, merge all chunks into final response
  const finalResponse = mergeChunksToResponse(allTranslated, sourceFormat);

  return {
    success: true,
    response: new Response(JSON.stringify(finalResponse), {
      // CORS wildcard intentionally omitted — see createOpenAIResponse path.
      headers: {
        "Content-Type": "application/json"
      }
    })
  };
}

/**
 * Create streaming response with translation
 * Use translator to convert OpenAI chunks → sourceFormat
 */
function createStreamingResponse(sourceFormat, model, text) {
  const openaiResponse = createOpenAIResponse(model, text);
  const state = initState(sourceFormat);
  state.model = model;

  // Create OpenAI streaming chunks
  const openaiChunks = createOpenAIStreamingChunks(openaiResponse);

  // Translate each chunk to sourceFormat using translator
  const translatedChunks = [];

  for (const chunk of openaiChunks) {
    const translated = translateResponse(FORMATS.OPENAI, sourceFormat, chunk, state);
    if (translated?.length > 0) {
      for (const item of translated) {
        translatedChunks.push(formatSSE(item, sourceFormat));
      }
    }
  }

  // Flush remaining events
  const flushed = translateResponse(FORMATS.OPENAI, sourceFormat, null, state);
  if (flushed?.length > 0) {
    for (const item of flushed) {
      translatedChunks.push(formatSSE(item, sourceFormat));
    }
  }

  // Add [DONE]
  translatedChunks.push("data: [DONE]\n\n");

  return {
    success: true,
    response: new Response(translatedChunks.join(""), {
      // CORS wildcard intentionally omitted — see createOpenAIResponse path.
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      }
    })
  };
}

/**
 * Merge translated chunks into final response object (for non-streaming)
 * Takes the last complete chunk as the final response
 */
function mergeChunksToResponse(chunks, sourceFormat) {
  if (!chunks || chunks.length === 0) {
    return createOpenAIResponse("unknown");
  }

  if (sourceFormat === FORMATS.CLAUDE) {
    const messageStop = chunks.find((c) => c.type === "message_stop");
    if (!messageStop) {
      return createOpenAIResponse("unknown");
    }
    const messageDelta = chunks.find((c) => c.type === "message_delta");
    const messageStart = chunks.find((c) => c.type === "message_start");
    let finalChunk = chunks[chunks.length - 1];

    if (messageStart?.message) {
      finalChunk = { ...messageStart.message };

      let accumulatedText = "";
      let accumulatedThinking = "";
      const toolInputByIndex = new Map();
      const openToolBlocks = new Map();

      for (const c of chunks) {
        if (c.type === "content_block_start" && c.content_block?.type === "tool_use") {
          openToolBlocks.set(c.index, { ...c.content_block, input: c.content_block.input || {} });
        }
        if (c.type === "content_block_delta" && c.delta) {
          if (c.delta.type === "text_delta" && c.delta.text) {
            accumulatedText += c.delta.text;
          } else if (c.delta.type === "thinking_delta" && c.delta.thinking) {
            accumulatedThinking += c.delta.thinking;
          } else if (c.delta.type === "input_json_delta") {
            const prev = toolInputByIndex.get(c.index) || "";
            toolInputByIndex.set(c.index, prev + (c.delta.partial_json || ""));
          }
        }
      }

      if (!Array.isArray(finalChunk.content)) {
        finalChunk.content = [];
      }

      if (accumulatedThinking) {
        const thinkingBlock = finalChunk.content.find((b) => b.type === "thinking");
        if (thinkingBlock) {
          thinkingBlock.thinking = accumulatedThinking;
        } else {
          finalChunk.content.unshift({ type: "thinking", thinking: accumulatedThinking });
        }
      }

      if (accumulatedText) {
        const textBlock = finalChunk.content.find((b) => b.type === "text");
        if (textBlock) {
          textBlock.text = accumulatedText;
        } else {
          finalChunk.content.push({ type: "text", text: accumulatedText });
        }
      }

      for (const [index, partialJson] of toolInputByIndex.entries()) {
        const base = openToolBlocks.get(index);
        if (!base) continue;
        try {
          base.input = JSON.parse(partialJson);
        } catch {
          base.input = base.input || {};
        }
        const existing = finalChunk.content.find((b) => b.type === "tool_use" && b.id === base.id);
        if (existing) {
          existing.input = base.input;
        } else {
          finalChunk.content.push({ type: "tool_use", id: base.id, name: base.name, input: base.input });
        }
      }

      if (messageDelta?.usage) {
        finalChunk.usage = messageDelta.usage;
      }
    }

    return finalChunk;
  }

  const last = chunks[chunks.length - 1];
  const hasFinish = last?.choices?.[0]?.finish_reason != null || last?.finish_reason != null;
  if (!hasFinish) {
    return createOpenAIResponse("unknown");
  }
  return last;
}

/**
 * Create OpenAI streaming chunks from complete response
 */
function createOpenAIStreamingChunks(completeResponse) {
  const { id, created, model, choices } = completeResponse;
  const content = choices[0].message.content;

  return [
    // Chunk with content
    {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{
        index: 0,
        delta: {
          role: "assistant",
          content
        },
        finish_reason: null
      }]
    },
    // Final chunk with finish_reason
    {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{
        index: 0,
        delta: {},
        finish_reason: "stop"
      }],
      usage: completeResponse.usage
    }
  ];
}
