/**
 * Hard invariant: every cache_control region and every message/block at or before
 * the last cache breakpoint must remain byte-for-byte identical after compression.
 * Violating this silently corrupts Anthropic/OpenAI KV prompt cache.
 */

import { normalizeAnthropicBuiltinToolModel } from "../translator/helpers/anthropicToolModel.js";

export function itemHasCacheControl(item) {
  if (!item || typeof item !== "object") return false;
  if (item.cache_control) return true;
  if (Array.isArray(item.content)) {
    return item.content.some((block) => block?.cache_control);
  }
  if (Array.isArray(item.parts)) {
    return item.parts.some((part) => part?.cache_control);
  }
  return false;
}

function geminiContentsArray(body) {
  if (Array.isArray(body?.contents)) return body.contents;
  if (Array.isArray(body?.request?.contents)) return body.request.contents;
  return null;
}

/** Last index in an array whose element carries cache_control (block or top-level). */
export function findLastCachedIndexInArray(arr) {
  if (!Array.isArray(arr)) return -1;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (itemHasCacheControl(arr[i])) return i;
  }
  return -1;
}

/** Last message/input index with a cache_control marker. */
export function findLastCacheBoundary(messages) {
  if (!Array.isArray(messages)) return -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (itemHasCacheControl(messages[i])) return i;
  }
  return -1;
}

function shouldProtectArrayItem(i, floor, item) {
  if (itemHasCacheControl(item)) return true;
  if (floor >= 0 && i <= floor) return true;
  return false;
}

function snapshotProtectedArray(arr, floor) {
  if (!Array.isArray(arr)) return null;
  const snap = [];
  for (let i = 0; i < arr.length; i++) {
    snap.push(shouldProtectArrayItem(i, floor, arr[i]) ? JSON.stringify(arr[i]) : null);
  }
  return snap;
}

function verifyProtectedArray(arr, snap, itemMatchesSnapshot) {
  if (!snap) return true;
  const hasProtected = snap.some((s) => s != null);
  if (!Array.isArray(arr)) return !hasProtected;
  for (let i = 0; i < snap.length; i++) {
    if (snap[i] == null) continue;
    if (i >= arr.length) return false;
    if (itemMatchesSnapshot) {
      if (!itemMatchesSnapshot(arr[i], snap[i])) return false;
    } else if (JSON.stringify(arr[i]) !== snap[i]) {
      return false;
    }
  }
  if (hasProtected && arr.length > snap.length) return false;
  return true;
}

/** Built-in tool model prefix strip is allowed in cache-protected tools (Anthropic rejects cc/ etc.). */
function toolMatchesCacheSnapshot(tool, snapJson) {
  if (JSON.stringify(tool) === snapJson) return true;
  let expected;
  try {
    expected = JSON.parse(snapJson);
  } catch {
    return false;
  }
  if (!expected?.type || expected.type === "function") return false;
  const normalized = { ...expected };
  if (typeof normalized.model === "string") {
    normalized.model = normalizeAnthropicBuiltinToolModel(normalized.model);
  }
  const actual = { ...tool };
  if (typeof actual.model === "string") {
    actual.model = normalizeAnthropicBuiltinToolModel(actual.model);
  }
  return JSON.stringify(actual) === JSON.stringify(normalized);
}

/** Kiro history/currentMessage wraps payload under userInputMessage. */
function kiroConversationItemHasCacheControl(item) {
  if (itemHasCacheControl(item)) return true;
  return itemHasCacheControl(item?.userInputMessage);
}

export function hasAnthropicCacheBreakpoints(body) {
  if (!body || typeof body !== "object") return false;
  if (Array.isArray(body.system) && body.system.some((b) => b?.cache_control)) return true;
  if (Array.isArray(body.tools) && body.tools.some((t) => t?.cache_control)) return true;
  if (Array.isArray(body.messages) && body.messages.some((msg) => itemHasCacheControl(msg))) return true;
  if (Array.isArray(body.input) && body.input.some((item) => itemHasCacheControl(item))) return true;
  const contents = geminiContentsArray(body);
  if (contents && contents.some((item) => itemHasCacheControl(item))) return true;
  if (body.conversationState) {
    const history = body.conversationState.history;
    if (Array.isArray(history) && history.some((item) => kiroConversationItemHasCacheControl(item))) return true;
    if (kiroConversationItemHasCacheControl(body.conversationState.currentMessage)) return true;
  }
  return false;
}

/**
 * Strip every Anthropic cache_control marker from a request body, in place.
 * Used when the target endpoint speaks OpenAI format and cannot honor Anthropic
 * cache breakpoints anyway — dropping them is lossless to the upstream request.
 * Returns the same body for chaining.
 */
export function stripAnthropicCacheBreakpoints(body) {
  if (!body || typeof body !== "object") return body;

  const stripFromBlock = (block) => {
    if (!block || typeof block !== "object") return;
    delete block.cache_control;
  };
  const stripFromItem = (item) => {
    if (!item || typeof item !== "object") return;
    delete item.cache_control;
    if (Array.isArray(item.content)) item.content.forEach(stripFromBlock);
    if (Array.isArray(item.parts)) item.parts.forEach(stripFromBlock);
  };

  if (Array.isArray(body.system)) body.system.forEach(stripFromBlock);
  if (Array.isArray(body.tools)) body.tools.forEach(stripFromBlock);
  if (Array.isArray(body.messages)) body.messages.forEach(stripFromItem);
  if (Array.isArray(body.input)) body.input.forEach(stripFromItem);
  const contents = geminiContentsArray(body);
  if (contents) contents.forEach(stripFromItem);
  if (body.conversationState) {
    const history = body.conversationState.history;
    if (Array.isArray(history)) history.forEach(stripFromItem);
    stripFromItem(body.conversationState.currentMessage);
  }
  return body;
}

/**
 * Snapshot every cache-protected region in the request body before compression.
 * Returns null when no cache_control markers are present.
 */
export function snapshotCacheProtectedBody(body) {
  if (!body || !hasAnthropicCacheBreakpoints(body)) return null;

  const snapshot = {};

  if (Array.isArray(body.system)) {
    snapshot.system = snapshotProtectedArray(body.system, findLastCachedIndexInArray(body.system));
  }
  if (typeof body.system === "string" && body.system.length > 0) {
    snapshot.systemString = body.system;
  }

  if (Array.isArray(body.tools)) {
    snapshot.tools = snapshotProtectedArray(body.tools, findLastCachedIndexInArray(body.tools));
  }

  if (Array.isArray(body.messages)) {
    snapshot.messages = snapshotProtectedArray(body.messages, findLastCacheBoundary(body.messages));
  }

  if (Array.isArray(body.input)) {
    snapshot.input = snapshotProtectedArray(body.input, findLastCacheBoundary(body.input));
  }

  const contents = geminiContentsArray(body);
  if (contents) {
    snapshot.contents = snapshotProtectedArray(contents, findLastCacheBoundary(contents));
  }

  if (body.conversationState) {
    const history = body.conversationState.history;
    if (Array.isArray(history)) {
      snapshot.conversationHistory = snapshotProtectedArray(history, findLastCacheBoundary(history));
    }
    if (body.conversationState.currentMessage) {
      snapshot.conversationCurrentMessage = JSON.stringify(body.conversationState.currentMessage);
    }
  }

  if (body.metadata !== undefined) {
    snapshot.metadata = JSON.stringify(body.metadata);
  }

  return snapshot;
}

/** Returns true when every protected region is still byte-identical to the snapshot. */
export function verifyCacheProtectedBody(body, snapshot) {
  if (!snapshot) return true;
  if (!body) return false;

  if (snapshot.systemString !== undefined) {
    if (body.system !== snapshot.systemString) return false;
  }
  if (!verifyProtectedArray(body.system, snapshot.system)) return false;
  if (!verifyProtectedArray(body.tools, snapshot.tools, toolMatchesCacheSnapshot)) return false;
  if (!verifyProtectedArray(body.messages, snapshot.messages)) return false;
  if (!verifyProtectedArray(body.input, snapshot.input)) return false;

  const contents = geminiContentsArray(body);
  if (!verifyProtectedArray(contents, snapshot.contents)) return false;

  if (snapshot.conversationHistory) {
    const history = body.conversationState?.history;
    if (!verifyProtectedArray(history, snapshot.conversationHistory)) return false;
  }
  if (snapshot.conversationCurrentMessage !== undefined) {
    const current = body.conversationState?.currentMessage;
    if (JSON.stringify(current) !== snapshot.conversationCurrentMessage) return false;
  }

  if (snapshot.metadata !== undefined) {
    if (JSON.stringify(body.metadata) !== snapshot.metadata) return false;
  }

  return true;
}

function restoreBodyFromSnapshot(target, source) {
  if (!target || !source || typeof source !== "object") return;
  for (const key of Object.keys(target)) {
    if (!(key in source)) delete target[key];
  }
  Object.assign(target, source);
}

/** Restore body from a JSON snapshot when cache integrity check fails. */
export function restoreBodyFromJsonSnapshot(body, jsonSnapshot) {
  if (!jsonSnapshot) return false;
  try {
    restoreBodyFromSnapshot(body, JSON.parse(jsonSnapshot));
    return true;
  } catch {
    return false;
  }
}

/** Fail closed when protected regions drift (executor / debug paths). */
export function throwOnCacheViolation(body, snapshot, stage = "executor") {
  if (!snapshot) return;
  if (verifyCacheProtectedBody(body, snapshot)) return;
  const err = new Error(`Cache-protected request content was modified after ${stage}`);
  err.code = "cache_integrity_failed";
  throw err;
}

/** RTK: skip compressing this message index — hard no-touch rule. */
export function shouldSkipMessageForCache(i, items, cacheFloor) {
  if (!Array.isArray(items) || !items[i]) return true;
  if (itemHasCacheControl(items[i])) return true;
  if (cacheFloor < 0) return false;
  return i <= cacheFloor;
}
