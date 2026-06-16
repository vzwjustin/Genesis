// Claude helper functions for translator
import { DEFAULT_THINKING_CLAUDE_SIGNATURE } from "../../config/defaultThinkingSignature.js";
import { adjustMaxTokens } from "./maxTokensHelper.js";
import { applyCloaking } from "../../utils/claudeCloaking.js";
import { deriveSessionId } from "../../utils/sessionManager.js";
import { getCachedClaudeHeaders } from "../../utils/claudeHeaderCache.js";
import {
  hasAnthropicCacheBreakpoints,
  findLastCachedIndexInArray,
  findLastCacheBoundary,
  itemHasCacheControl,
} from "../../rtk/cacheBoundary.js";
import {
  normalizeAnthropicBuiltinToolModel,
  stripProviderModelPrefix,
} from "./anthropicToolModel.js";
import { isKimiProvider, prepareKimiRequest } from "./kimiHelper.js";

export { stripProviderModelPrefix, normalizeAnthropicBuiltinToolModel } from "./anthropicToolModel.js";
export { hasAnthropicCacheBreakpoints };

/** First-party Anthropic endpoints keep all built-in tools (uncached tail still normalized). */
export function isAnthropicBuiltinToolPassthroughProvider(provider) {
  return provider === "claude" || provider?.startsWith("anthropic-compatible");
}

/** Claude /v1/messages API providers plus OpenAI/Gemini when body carries cache_control. */
export function usesAnthropicToolCleaning(provider, clientHasCacheBreakpoints = false) {
  if (isAnthropicBuiltinToolPassthroughProvider(provider)) return true;
  if (new Set(["minimax", "minimax-cn", "glm", "kimi", "kimi-coding"]).has(provider)) return true;
  if (clientHasCacheBreakpoints && ["openai", "gemini", "gemini-cli", "antigravity"].includes(provider)) {
    return true;
  }
  return false;
}

export function hasValidContent(msg) {
  if (typeof msg.content === "string" && msg.content.trim()) return true;
  if (Array.isArray(msg.content)) {
    return msg.content.some(block =>
      (block.type === "text" && block.text?.trim()) ||
      block.type === "tool_use" ||
      block.type === "tool_result" ||
      block.type === "image" ||
      block.type === "document"
    );
  }
  return false;
}

/**
 * Clean Anthropic tool definitions for upstream compatibility.
 * When preserveClientCache is true, tools at or before the last cache breakpoint stay
 * byte-identical except built-in tool model prefix normalization (Anthropic rejects cc/).
 * Uncached tail only: client tools strip model/type; built-in tools strip provider prefix from model.
 */
export function cleanAnthropicToolDefinitions(tools, provider, { preserveClientCache = false } = {}) {
  if (!tools || !Array.isArray(tools)) return tools;

  const isAnthropicEndpoint = isAnthropicBuiltinToolPassthroughProvider(provider);
  const cacheToolFloor = preserveClientCache ? findLastCachedIndexInArray(tools) : -1;

  const isCacheProtectedToolIndex = (index) => {
    if (!preserveClientCache) return false;
    const tool = tools[index];
    if (!tool) return false;
    return itemHasCacheControl(tool) || (cacheToolFloor >= 0 && index <= cacheToolFloor);
  };

  const entries = isAnthropicEndpoint
    ? tools.map((tool, index) => ({ tool, index }))
    : tools.reduce((acc, tool, index) => {
        if (isCacheProtectedToolIndex(index) || !tool.type || tool.type === "function") {
          acc.push({ tool, index });
        }
        return acc;
      }, []);

  return entries.map(({ tool, index }) => {
    const toolProtected = isCacheProtectedToolIndex(index);

    // Cache-protected prefix: byte-identical except built-in tool model prefix strip
    // (Anthropic rejects cc/… in tools.N.model even on cache breakpoints).
    if (toolProtected) {
      if (tool.type && tool.type !== "function" && typeof tool.model === "string") {
        const normalized = normalizeAnthropicBuiltinToolModel(tool.model);
        if (normalized !== tool.model) {
          return { ...tool, model: normalized };
        }
      }
      return { ...tool };
    }

    if (!tool.type || tool.type === "function") {
      const { model, type, ...clientRest } = tool;
      return { ...clientRest };
    }

    const cleanedTool = { ...tool };
    if (typeof cleanedTool.model === "string") {
      cleanedTool.model = normalizeAnthropicBuiltinToolModel(cleanedTool.model);
    }
    return cleanedTool;
  });
}

// Fix tool_use/tool_result ordering for Claude API
// 1. Assistant message with tool_use: remove text AFTER tool_use (Claude doesn't allow)
// 2. Merge consecutive same-role messages
export function fixToolUseOrdering(messages) {
  if (messages.length <= 1) return messages;

  const messageHasCacheMarker = (msg) => {
    if (!msg) return false;
    if (msg.cache_control) return true;
    if (!Array.isArray(msg.content)) return false;
    return msg.content.some((block) => block?.cache_control);
  };

  const cacheFloor = findLastCacheBoundary(messages);

  // Pass 1: Fix assistant messages with tool_use - remove text after tool_use
  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi];
    if (messageHasCacheMarker(msg) || (cacheFloor >= 0 && mi <= cacheFloor)) continue;
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const hasToolUse = msg.content.some(b => b.type === "tool_use");
      if (hasToolUse) {
        // Keep only: thinking blocks + tool_use blocks (remove text blocks after tool_use)
        const newContent = [];
        let foundToolUse = false;

        for (const block of msg.content) {
          if (block.type === "tool_use") {
            foundToolUse = true;
            newContent.push(block);
          } else if (block.type === "thinking" || block.type === "redacted_thinking") {
            newContent.push(block);
          } else if (!foundToolUse) {
            // Keep text blocks BEFORE tool_use
            newContent.push(block);
          }
          // Skip text blocks AFTER tool_use
        }

        msg.content = newContent;
      }
    }
  }

  const contentHasToolUse = (content) =>
    Array.isArray(content) && content.some((b) => b.type === "tool_use");

  const contentHasToolResult = (content) =>
    Array.isArray(content) && content.some((b) => b.type === "tool_result");

  const cloneMessageShell = (msg, content) => {
    const out = { role: msg.role, content };
    if (msg.cache_control) out.cache_control = msg.cache_control;
    if (msg.id) out.id = msg.id;
    return out;
  };

  // Pass 2: Merge consecutive same-role messages
  const merged = [];
  let lastOrigIdx = -1;

  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi];
    const last = merged[merged.length - 1];
    const msgContent = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: msg.content }];
    const skipMerge = last?.role === "assistant" && (contentHasToolUse(last.content) || contentHasToolUse(msgContent))
      || contentHasToolResult(last?.content) || contentHasToolResult(msgContent)
      || messageHasCacheMarker(last) || messageHasCacheMarker(msg)
      || (cacheFloor >= 0 && ((lastOrigIdx >= 0 && lastOrigIdx <= cacheFloor) || mi <= cacheFloor));

    if (last && last.role === msg.role && !skipMerge) {
      // Merge content arrays (text-only / homogeneous blocks — never mix tool_result with other types)
      const lastContent = Array.isArray(last.content) ? last.content : [{ type: "text", text: last.content }];
      last.content = [...lastContent, ...msgContent];
      lastOrigIdx = mi;
    } else {
      const isProtected = messageHasCacheMarker(msg) || (cacheFloor >= 0 && mi <= cacheFloor);
      if (isProtected) {
        // Cache prefix: preserve string vs array shape byte-for-byte.
        const content = Array.isArray(msg.content) ? [...msg.content] : msg.content;
        merged.push(cloneMessageShell(msg, content));
      } else {
        const content = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: msg.content }];
        merged.push(cloneMessageShell(msg, [...content]));
      }
      lastOrigIdx = mi;
    }
  }

  return merged;
}

const CLAUDE_FORMAT_PROVIDERS_WITHOUT_OUTPUT_CONFIG = new Set(["minimax", "minimax-cn", "kimi", "kimi-coding"]);

function usesClaudeThinkingCompat(provider) {
  return provider === "claude"
    || provider?.startsWith("anthropic-compatible")
    || isKimiProvider(provider);
}

// Prepare request for Claude format endpoints
// - Optionally normalize cache_control (skipped when client already set breakpoints)
// - Filter empty messages
// - Add thinking block for Anthropic endpoint (provider === "claude")
// - Fix tool_use/tool_result ordering
// - Apply cloaking (billing header + fake user ID) for OAuth tokens
export function prepareClaudeRequest(body, provider = null, apiKey = null, connectionId = null, requestHeaders = null) {
  const preserveClientCache = hasAnthropicCacheBreakpoints(body);

  // Client-owned cache layout: only OAuth metadata cloaking — no message/tool rewriting.
  if (preserveClientCache) {
    if ((provider === "claude" || provider?.startsWith("anthropic-compatible")) && apiKey) {
      const cached = connectionId ? getCachedClaudeHeaders(connectionId, requestHeaders) : null;
      const headerSessionId = cached?.["x-claude-code-session-id"];
      const sessionId = headerSessionId || (connectionId ? deriveSessionId(connectionId) : null);
      body = applyCloaking(body, apiKey, sessionId);
    }
    // Tool-order fixes apply only after the last message cache breakpoint.
    if (body.messages && Array.isArray(body.messages)) {
      const cacheFloor = findLastCacheBoundary(body.messages);
      if (cacheFloor >= 0 && cacheFloor < body.messages.length - 1) {
        const prefix = body.messages.slice(0, cacheFloor + 1);
        const tail = fixToolUseOrdering(body.messages.slice(cacheFloor + 1));
        body.messages = [...prefix, ...tail];
      } else if (cacheFloor < 0) {
        body.messages = fixToolUseOrdering(body.messages);
      }
    }
    if (body.tools && Array.isArray(body.tools)) {
      body.tools = cleanAnthropicToolDefinitions(body.tools, provider, { preserveClientCache });
      if (body.tools.length === 0) {
        delete body.tools;
        delete body.tool_choice;
      }
    }
    prepareKimiRequest(body, provider, body.model);
    return body;
  }

  // MiniMax exposes a Claude-compatible endpoint but rejects Anthropic's extended
  // structured output parameter with a generic 400 "invalid params" response.
  if (CLAUDE_FORMAT_PROVIDERS_WITHOUT_OUTPUT_CONFIG.has(provider)) {
    delete body.output_config;
  }

  // 1. System: only rewrite cache_control when the client did not set breakpoints
  if (!preserveClientCache && body.system && Array.isArray(body.system)) {
    body.system = body.system.map((block, i) => {
      const { cache_control, ...rest } = block;
      if (i === body.system.length - 1) {
        return { ...rest, cache_control: { type: "ephemeral", ttl: "1h" } };
      }
      return rest;
    });
  }

  // 2. Messages: process in optimized passes
  if (body.messages && Array.isArray(body.messages)) {
    const len = body.messages.length;
    let filtered = [];

    // Pass 1: remove cache_control + filter empty messages
    for (let i = 0; i < len; i++) {
      const msg = body.messages[i];

      // Remove cache_control from content blocks (only when normalizing cache ourselves)
      if (!preserveClientCache && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          delete block.cache_control;
        }
      }

      // Keep final assistant even if empty, otherwise check valid content
      const isFinalAssistant = i === len - 1 && msg.role === "assistant";
      if (isFinalAssistant || hasValidContent(msg)) {
        filtered.push(msg);
      }
    }

    // Pass 1.5: Fix tool_use/tool_result ordering
    // Each tool_use must have tool_result in the NEXT message (not same message with other content)
    filtered = fixToolUseOrdering(filtered);

    body.messages = filtered;

    // Check if thinking is enabled AND last message is from user
    const lastMessage = filtered[filtered.length - 1];
    const lastMessageIsUser = lastMessage?.role === "user";
    const thinkingEnabled = body.thinking?.type === "enabled" && lastMessageIsUser;

    // Pass 2 (reverse): optional cache_control on last assistant + thinking for Anthropic
    let lastAssistantProcessed = false;
    for (let i = filtered.length - 1; i >= 0; i--) {
      const msg = filtered[i];

      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        if (!preserveClientCache && !lastAssistantProcessed && msg.content.length > 0) {
          for (let j = msg.content.length - 1; j >= 0; j--) {
            const block = msg.content[j];
            if (block.type !== "thinking" && block.type !== "redacted_thinking") {
              block.cache_control = { type: "ephemeral" };
              break;
            }
          }
          lastAssistantProcessed = true;
        }

        // Handle thinking blocks for Anthropic and Kimi Coding endpoints
        if (usesClaudeThinkingCompat(provider)) {
          let hasToolUse = false;
          let hasThinking = false;

          // Replace signatures only when we own cache layout — client breakpoints
          // include thinking blocks and mutating them invalidates KV cache hits.
          if (!preserveClientCache) {
            for (const block of msg.content) {
              if (block.type === "thinking" || block.type === "redacted_thinking") {
                block.signature = DEFAULT_THINKING_CLAUDE_SIGNATURE;
                hasThinking = true;
              }
              if (block.type === "tool_use") hasToolUse = true;
            }
          } else {
            for (const block of msg.content) {
              if (block.type === "thinking" || block.type === "redacted_thinking") hasThinking = true;
              if (block.type === "tool_use") hasToolUse = true;
            }
          }

          // Add thinking block if thinking enabled + has tool_use but no thinking
          if (!preserveClientCache && thinkingEnabled && !hasThinking && hasToolUse) {
            msg.content.unshift({
              type: "thinking",
              thinking: ".",
              signature: DEFAULT_THINKING_CLAUDE_SIGNATURE
            });
          }
        }
      }
    }
  }

  // 3. Tools: filter built-in tools for non-Anthropic providers, then handle cache_control
  if (body.tools && Array.isArray(body.tools)) {
    body.tools = cleanAnthropicToolDefinitions(body.tools, provider, { preserveClientCache });
    if (!preserveClientCache) {
      body.tools = body.tools.map((tool, i) => {
        if (i === body.tools.length - 1) {
          return { ...tool, cache_control: { type: "ephemeral", ttl: "1h" } };
        }
        return tool;
      });
    }

    // Remove tools array and tool_choice if empty after filtering
    if (body.tools.length === 0) {
      delete body.tools;
      delete body.tool_choice;
    }
  }

  // Apply cloaking for OAuth tokens (billing header + fake user ID)
  // session_id in user_id must match X-Claude-Code-Session-Id for fingerprint consistency
  if ((provider === "claude" || provider?.startsWith("anthropic-compatible")) && apiKey) {
    const cached = connectionId ? getCachedClaudeHeaders(connectionId, requestHeaders) : null;
    const headerSessionId = cached?.["x-claude-code-session-id"];
    const sessionId = headerSessionId || (connectionId ? deriveSessionId(connectionId) : null);
    body = applyCloaking(body, apiKey, sessionId);
  }

  prepareKimiRequest(body, provider, body.model);

  return body;
}
