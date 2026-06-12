// Tool call helper functions for translator
import { findLastCacheBoundary, shouldSkipMessageForCache } from "../../rtk/cacheBoundary.js";

/** Minimal non-empty placeholder for backfilled tool results (Anthropic rejects empty content). */
const MISSING_TOOL_RESPONSE_PLACEHOLDER = "[No response received]";

// Anthropic tool_use.id must match: ^[a-zA-Z0-9_-]+$
const TOOL_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

// Generate deterministic tool call ID from position + tool name (cache-friendly)
export function generateToolCallId(msgIndex = 0, tcIndex = 0, toolName = "") {
  const name = toolName ? `_${toolName.replace(/[^a-zA-Z0-9_-]/g, "")}` : "";
  return `call_msg${msgIndex}_tc${tcIndex}${name}`;
}

// Sanitize ID to match Anthropic pattern: keep only alphanumeric, underscore, hyphen
function sanitizeToolId(id) {
  if (!id || typeof id !== "string") return null;
  const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, "");
  return sanitized.length > 0 ? sanitized : null;
}

function canonicalizeToolId(id, msgIndex, tcIndex, toolName, idRemap) {
  if (id && idRemap.has(id)) return idRemap.get(id);
  if (id && TOOL_ID_PATTERN.test(id)) return id;

  const original = id;
  const sanitized = sanitizeToolId(id);
  const canonical = sanitized || generateToolCallId(msgIndex, tcIndex, toolName);
  if (original && original !== canonical) idRemap.set(original, canonical);
  return canonical;
}

function applyToolIdRemap(id, msgIndex, blockIndex, idRemap) {
  if (!id) return generateToolCallId(msgIndex, blockIndex);
  if (idRemap.has(id)) return idRemap.get(id);
  if (TOOL_ID_PATTERN.test(id)) return id;
  return canonicalizeToolId(id, msgIndex, blockIndex, null, idRemap);
}

// Ensure all tool_calls have valid id field and arguments is string (some providers require it)
export function ensureToolCallIds(body) {
  if (!body.messages || !Array.isArray(body.messages)) return body;

  const idRemap = new Map();
  const cacheFloor = findLastCacheBoundary(body.messages);

  for (let i = 0; i < body.messages.length; i++) {
    if (shouldSkipMessageForCache(i, body.messages, cacheFloor)) continue;
    const msg = body.messages[i];
    if (msg.role === "assistant" && msg.tool_calls && Array.isArray(msg.tool_calls)) {
      for (let j = 0; j < msg.tool_calls.length; j++) {
        const tc = msg.tool_calls[j];
        if (!tc.id || !TOOL_ID_PATTERN.test(tc.id)) {
          tc.id = canonicalizeToolId(tc.id, i, j, tc.function?.name, idRemap);
        }
        if (!tc.type) {
          tc.type = "function";
        }
        if (tc.function?.arguments && typeof tc.function.arguments !== "string") {
          tc.function.arguments = JSON.stringify(tc.function.arguments);
        }
      }
    }

    if (Array.isArray(msg.content)) {
      for (let k = 0; k < msg.content.length; k++) {
        const block = msg.content[k];
        if (block.type === "tool_use" && block.id && !TOOL_ID_PATTERN.test(block.id)) {
          block.id = canonicalizeToolId(block.id, i, k, block.name, idRemap);
        }
      }
    }
  }

  for (let i = 0; i < body.messages.length; i++) {
    if (shouldSkipMessageForCache(i, body.messages, cacheFloor)) continue;
    const msg = body.messages[i];

    if (msg.role === "tool" && msg.tool_call_id) {
      msg.tool_call_id = applyToolIdRemap(msg.tool_call_id, i, 0, idRemap);
    }

    if (Array.isArray(msg.content)) {
      for (let k = 0; k < msg.content.length; k++) {
        const block = msg.content[k];
        if (block.type === "tool_result" && block.tool_use_id) {
          block.tool_use_id = applyToolIdRemap(block.tool_use_id, i, k, idRemap);
        }
      }
    }
  }

  return body;
}

// Get tool_call ids from assistant message (OpenAI format: tool_calls, Claude format: tool_use in content)
export function getToolCallIds(msg) {
  if (msg.role !== "assistant") return [];

  const ids = [];

  // OpenAI format: tool_calls array
  if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      if (tc.id) ids.push(tc.id);
    }
  }

  // Claude format: tool_use blocks in content
  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block.type === "tool_use" && block.id) {
        ids.push(block.id);
      }
    }
  }

  return ids;
}

function collectRespondedToolIds(messages, startIndex, toolCallIds) {
  const respondedIds = new Set();
  let insertPosition = startIndex + 1;

  for (let j = startIndex + 1; j < messages.length; j++) {
    const nextMsg = messages[j];

    if (nextMsg.role === "tool" && nextMsg.tool_call_id && toolCallIds.includes(nextMsg.tool_call_id)) {
      respondedIds.add(nextMsg.tool_call_id);
      insertPosition = j + 1;
      continue;
    }

    if (nextMsg.role === "user" && Array.isArray(nextMsg.content)) {
      let found = false;
      for (const block of nextMsg.content) {
        if (block.type === "tool_result" && toolCallIds.includes(block.tool_use_id)) {
          respondedIds.add(block.tool_use_id);
          found = true;
        }
      }
      if (found) {
        insertPosition = j + 1;
        continue;
      }
    }

    break;
  }

  return { respondedIds, insertPosition };
}

function usesClaudeNativeToolFormat(messages) {
  if (!Array.isArray(messages)) return false;
  return messages.some((msg) =>
    Array.isArray(msg.content) &&
    msg.content.some((block) => block.type === "tool_use" || block.type === "tool_result")
  );
}

// Fix missing tool responses for Claude-native threads (tool_use / tool_result in content arrays)
export function fixMissingClaudeToolResponses(body) {
  if (!body.messages || !Array.isArray(body.messages)) return body;

  const messages = [...body.messages];
  const cacheFloor = findLastCacheBoundary(messages);

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const toolCallIds = getToolCallIds(msg);
    if (toolCallIds.length === 0) continue;

    const { respondedIds, insertPosition } = collectRespondedToolIds(messages, i, toolCallIds);
    const missingIds = toolCallIds.filter((id) => !respondedIds.has(id));
    if (missingIds.length === 0) continue;

    if (cacheFloor >= 0 && insertPosition <= cacheFloor) continue;

    const missingResponse = {
      role: "user",
      content: missingIds.map((id) => ({
        type: "tool_result",
        tool_use_id: id,
        content: MISSING_TOOL_RESPONSE_PLACEHOLDER
      }))
    };
    messages.splice(insertPosition, 0, missingResponse);
    i = insertPosition;
  }

  body.messages = messages;
  return body;
}

function fixMissingGeminiContentsToolResponses(contents) {
  if (!Array.isArray(contents)) return contents;

  for (let i = 0; i < contents.length; i++) {
    const content = contents[i];
    if (content.role !== "model" || !Array.isArray(content.parts)) continue;

    const functionCalls = content.parts
      .filter((part) => part.functionCall)
      .map((part) => ({
        id: part.functionCall.id || part.functionCall.name,
        name: part.functionCall.name,
      }));
    if (functionCalls.length === 0) continue;

    const respondedIds = new Set();
    for (let j = i + 1; j < contents.length; j++) {
      if (contents[j].role === "model") break;
      if (contents[j].role !== "user" || !Array.isArray(contents[j].parts)) continue;
      for (const part of contents[j].parts) {
        if (!part.functionResponse) continue;
        respondedIds.add(part.functionResponse.id || part.functionResponse.name);
      }
    }

    const missing = functionCalls.filter((fc) => !respondedIds.has(fc.id) && !respondedIds.has(fc.name));
    if (missing.length === 0) continue;

    const placeholderParts = missing.map((fc) => ({
      functionResponse: {
        id: fc.id,
        name: fc.name,
        response: { result: MISSING_TOOL_RESPONSE_PLACEHOLDER },
      },
    }));
    contents.splice(i + 1, 0, { role: "user", parts: placeholderParts });
    i += 1;
  }

  return contents;
}

// Fix missing tool responses - insert empty tool_result if assistant has tool_use but next message has no tool_result
export function fixMissingToolResponses(body) {
  if (body.contents && Array.isArray(body.contents)) {
    body.contents = fixMissingGeminiContentsToolResponses([...body.contents]);
    return body;
  }
  if (body.request?.contents && Array.isArray(body.request.contents)) {
    body.request.contents = fixMissingGeminiContentsToolResponses([...body.request.contents]);
    return body;
  }

  if (!body.messages || !Array.isArray(body.messages)) return body;

  if (usesClaudeNativeToolFormat(body.messages)) {
    return fixMissingClaudeToolResponses(body);
  }

  const messages = [...body.messages];
  const cacheFloor = findLastCacheBoundary(messages);

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const toolCallIds = getToolCallIds(msg);
    if (toolCallIds.length === 0) continue;

    const { respondedIds, insertPosition } = collectRespondedToolIds(messages, i, toolCallIds);
    const missingIds = toolCallIds.filter((id) => !respondedIds.has(id));
    if (missingIds.length === 0) continue;

    if (cacheFloor >= 0 && insertPosition <= cacheFloor) continue;

    const missingResponses = missingIds.map((id) => ({
      role: "tool",
      tool_call_id: id,
      content: MISSING_TOOL_RESPONSE_PLACEHOLDER
    }));
    messages.splice(insertPosition, 0, ...missingResponses);
    i = insertPosition + missingResponses.length - 1;
  }

  body.messages = messages;
  return body;
}
