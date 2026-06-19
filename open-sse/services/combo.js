/**
 * Shared combo (model combo) handling with fallback support
 */

import { formatRetryAfter } from "./accountFallback.js";
import { unavailableResponse, PROXY_EXHAUSTED_HEADER, isProxyInternalError } from "../utils/error.js";
import { MIN_RETRY_DELAY_MS } from "../config/errorConfig.js";
import { extractTextContent } from "../translator/helpers/geminiHelper.js";

/**
 * Track rotation state per combo (for round-robin strategy)
 * @type {Map<string, { index: number, consecutiveUseCount: number, seq: number }>}
 */
const comboRotationState = new Map();
/** @type {Map<string, { current: Promise<void>, queued: Promise<void> }>} */
const comboRotationLocks = new Map();

async function withComboRotationLock(comboName, fn) {
  // Serialize on the same key getRotatedModels uses for rotation state, so
  // requests with no comboName still mutually exclude on the shared
  // "__default__" rotation counter instead of racing read-modify-write.
  const lockKey = comboName || "__default__";

  // `previous.queued` is the promise chain the new waiter must await to respect
  // ordering.  `current` is a fresh promise used both as the signal released
  // when this holder finishes and as the identity token for the cleanup check.
  const previousEntry = comboRotationLocks.get(lockKey);
  const previous = previousEntry?.queued || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  // Store both so the next waiter can chain onto `queued` while the finally
  // block can compare `current` by identity and correctly evict the entry.
  const queued = previous.catch(() => {}).then(() => current);
  comboRotationLocks.set(lockKey, { current, queued });

  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    // Only evict if no later waiter has already overwritten the entry.
    if (comboRotationLocks.get(lockKey)?.current === current) {
      comboRotationLocks.delete(lockKey);
    }
  }
}

function normalizeStickyLimit(stickyLimit) {
  const parsed = Number.parseInt(stickyLimit, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function rotateModelsFromIndex(models, currentIndex) {
  const rotatedModels = [...models];
  for (let i = 0; i < currentIndex; i++) {
    const moved = rotatedModels.shift();
    rotatedModels.push(moved);
  }
  return rotatedModels;
}

/**
 * Get rotated model list based on strategy
 * @param {string[]} models - Array of model strings
 * @param {string} comboName - Name of the combo
 * @param {string} strategy - "fallback" or "round-robin"
 * @param {number|string} [stickyLimit=1] - Requests per combo model before switching
 * @returns {string[]} Rotated models array
 */
export function getRotatedModels(models, comboName, strategy, stickyLimit = 1) {
  if (!models || models.length <= 1 || strategy !== "round-robin") {
    return models;
  }

  const rotationKey = comboName || "__default__";
  const normalizedStickyLimit = normalizeStickyLimit(stickyLimit);
  const state = comboRotationState.get(rotationKey) || { index: 0, consecutiveUseCount: 0, seq: 0 };
  const nextSeq = (state.seq ?? 0) + 1;

  const currentIndex = state.index % models.length;
  const rotatedModels = rotateModelsFromIndex(models, currentIndex);
  const nextUseCount = state.consecutiveUseCount + 1;

  if (nextUseCount >= normalizedStickyLimit) {
    comboRotationState.set(rotationKey, {
      index: (currentIndex + 1) % models.length,
      consecutiveUseCount: 0,
      seq: nextSeq,
    });
  } else {
    comboRotationState.set(rotationKey, {
      index: currentIndex,
      consecutiveUseCount: nextUseCount,
      seq: nextSeq,
    });
  }

  return rotatedModels;
}

/**
 * Reset in-memory rotation state when combo/settings change
 * @param {string} [comboName] - Combo name to reset; omit to clear all
 */
export function resetComboRotation(comboName) {
  if (comboName) comboRotationState.delete(comboName);
  else comboRotationState.clear();
}

/**
 * Validate that a model string is an actionable provider/model target.
 * A valid actionable target is a non-empty string that either:
 *   - Contains a "/" (explicit provider/model format), OR
 *   - Is a non-empty plain string (alias or model name that can be resolved downstream)
 *
 * @param {*} model - Value to validate
 * @returns {boolean} True if the model is a valid actionable target
 */
export function isValidComboModelTarget(model) {
  return typeof model === "string" && model.trim().length > 0;
}

/**
 * Get combo models from combos data.
 *
 * A combo match succeeds only when it resolves to a valid actionable provider/model target.
 * If the combo is found but has no valid actionable models, returns null (combo resolution failed).
 * The caller must not treat the combo-name match alone as success.
 *
 * @param {string} modelStr - Model string to check
 * @param {Array|Object} combosData - Array of combos or object with combos
 * @returns {string[]|null} Array of valid models or null if not a combo / combo has no valid targets
 */
export function getComboModelsFromData(modelStr, combosData) {
  // Don't check if it's in provider/model format
  if (modelStr.includes("/")) return null;
  
  // Handle both array and object formats
  const combos = Array.isArray(combosData) ? combosData : (combosData?.combos || []);
  
  const combo = combos.find(c => c.name === modelStr);
  if (!combo || !combo.models || !Array.isArray(combo.models)) return null;

  // Filter to only valid actionable targets — a combo match succeeds only when
  // it resolves to at least one valid actionable provider/model target.
  const validModels = combo.models.filter(isValidComboModelTarget);
  if (validModels.length < 1) return null;

  return validModels;
}

/**
 * Return a descriptive error when a combo name exists in data but has no valid targets.
 * @param {string} modelStr
 * @param {Array|Object} combosData
 * @returns {string|null}
 */
export function getBrokenComboErrorFromData(modelStr, combosData) {
  if (modelStr.includes("/")) return null;
  const combos = Array.isArray(combosData) ? combosData : (combosData?.combos || []);
  const combo = combos.find((c) => c.name === modelStr);
  if (!combo) return null;
  const validModels = (combo.models || []).filter(isValidComboModelTarget);
  if (validModels.length >= 1) return null;
  return `Combo "${modelStr}" has no valid model targets configured.`;
}

/**
 * Determine whether a combo should advance to the next model based on status code.
 *
 * Combo Sequencing Rules (Requirements 5.1–5.5):
 *   - 2xx: Return to client, do NOT advance (Req 5.2)
 *   - 429: Advance position, connection cooldown already applied by handleSingleModel (Req 5.4)
 *   - 5xx: Advance position, transient cooldown already applied by handleSingleModel (Req 5.5)
 *   - 4xx (excluding 429): Return to client, do NOT advance (Req 5.3)
 *
 * This is distinct from account-level fallback (checkFallbackError) which handles
 * per-connection retry within a single provider. Combo advancement operates at the
 * model/provider level after all per-connection retries are exhausted.
 *
 * @param {number} status - HTTP status code from the upstream response
 * @returns {boolean} True if the combo should advance to the next model
 */
export function shouldComboAdvance(status) {
  if (status === 429) return true;
  if (status >= 500) return true;
  return false;
}

/**
 * Detect whether a 404 response represents a zero-connections / no-credentials condition.
 * When a provider has zero configured connections, handleSingleModel returns HTTP 404
 * with "No active credentials for provider: ...". In a combo context, this should
 * cause advancement to the next model rather than returning to the client, because
 * it's a provider-level unavailability, not a client error.
 *
 * @param {Response} response - The HTTP response to check
 * @returns {Promise<boolean>} True if this is a zero-connections 404 that should advance
 */
export async function isZeroConnectionsResponse(response) {
  if (response.status !== 404) return false;
  const NO_CREDS_PREFIX = "No active credentials for provider:";
  let raw = "";
  try {
    raw = await response.clone().text();
  } catch {
    return false;
  }
  if (raw.includes(NO_CREDS_PREFIX)) return true;
  try {
    const body = JSON.parse(raw);
    return (body?.error?.message || "").startsWith(NO_CREDS_PREFIX);
  } catch {
    return false;
  }
}

/**
 * Detect proxy-side model resolution failures inside a combo member.
 * These are not upstream client errors — the combo should advance to the next model.
 */
export async function isModelResolutionFailureResponse(response) {
  if (response.status !== 400) return false;
  try {
    const body = await response.clone().json();
    const message = body?.error?.message || "";
    return (
      message.startsWith("Failed to resolve model:") ||
      message === "Invalid model format" ||
      message.includes("has no valid model targets configured")
    );
  } catch {
    return false;
  }
}

/**
 * Detect proxy-side provider account exhaustion (all connections failed / unavailable).
 * Distinguished from upstream semantic 401/403 by Retry-After or known proxy messages.
 * Combo should advance — this is provider-level unavailability, not a client auth error.
 */
/**
 * Detect proxy-generated errors (SSE assembly, parse failures, etc.).
 * These are not upstream provider faults — combo must not advance on them.
 */
export async function isProxyInternalResponse(response) {
  if (response.ok) return false;
  try {
    const body = await response.clone().json();
    const code = body?.error?.code || "";
    return isProxyInternalError({ errorCode: code });
  } catch {
    return false;
  }
}

export async function isProviderAccountsExhaustedResponse(response) {
  if (response.status !== 401 && response.status !== 403) return false;

  const hasProxyMarker = response.headers.get(PROXY_EXHAUSTED_HEADER) === "1";
  const hasRetryAfter = !!response.headers.get("Retry-After");

  try {
    const body = await response.clone().json();
    const message = body?.error?.message || "";
    const hasKnownMessage = (
      message.includes("All accounts unavailable") ||
      message.includes("No more accounts available") ||
      message.includes("Token refresh failed") ||
      message.startsWith("No active credentials for provider:")
    );
    if (hasKnownMessage) return true;
    // Retry-After alone is insufficient — require proxy exhaustion marker
    return hasProxyMarker && hasRetryAfter;
  } catch {
    return hasProxyMarker && hasRetryAfter;
  }
}

/**
 * Handle combo chat with fallback
 * @param {Object} options
 * @param {Object} options.body - Request body
 * @param {string[]} options.models - Array of model strings to try
 * @param {Function} options.handleSingleModel - Function to handle single model: (body, modelStr) => Promise<Response>
 * @param {Object} options.log - Logger object
 * @param {string} [options.comboName] - Name of the combo (for round-robin tracking)
 * @param {string} [options.comboStrategy] - Strategy: "fallback" or "round-robin"
 * @param {number|string} [options.comboStickyLimit=1] - Requests per combo model before switching
 * @returns {Promise<Response>}
 */
export async function handleComboChat({ body, models, handleSingleModel, log, comboName, comboStrategy, comboStickyLimit = 1 }) {
  let rotationStartIndex = 0;
  let rotationSeq = 0;
  let rotatedModels = models;
  let rotationSnapshot = null;

  await withComboRotationLock(comboName, async () => {
    if (comboStrategy === "round-robin" && models && models.length > 1) {
      const rotationKey = comboName || "__default__";
      const state = comboRotationState.get(rotationKey) || { index: 0, consecutiveUseCount: 0, seq: 0 };
      rotationSnapshot = { index: state.index, consecutiveUseCount: state.consecutiveUseCount, seq: state.seq ?? 0 };
      rotationStartIndex = state.index % models.length;
    }
    rotatedModels = getRotatedModels(models, comboName, comboStrategy, comboStickyLimit);
    if (comboStrategy === "round-robin" && models && models.length > 1) {
      const rotationKey = comboName || "__default__";
      rotationSeq = comboRotationState.get(rotationKey)?.seq ?? 0;
    }
  });

  let lastError = null;
  let earliestRetryAfter = null;
  let lastStatus = null;

  for (let i = 0; i < rotatedModels.length; i++) {
    const modelStr = rotatedModels[i];
    log.info("COMBO", `Trying model ${i + 1}/${rotatedModels.length}: ${modelStr}`);

    try {
      const result = await handleSingleModel(body, modelStr);

      if (result.ok) {
        log.info("COMBO", `Model ${modelStr} succeeded — returning response, combo position unchanged`);
        // Selection reserves a slot before the request leaves the process so
        // concurrent round-robin calls do not all hit the same model. A 2xx
        // response must still leave the committed combo position on the model
        // that actually served the response.
        if (comboStrategy === "round-robin" && i > 0) {
          const rotationKey = comboName || "__default__";
          const servedIndex = (rotationStartIndex + i) % models.length;
          await withComboRotationLock(comboName, async () => {
            const live = comboRotationState.get(rotationKey) || { index: 0, consecutiveUseCount: 0, seq: 0 };
            // Failover pins future rotation to the model that actually served.
            // First-try success keeps the reservation made by getRotatedModels().
            comboRotationState.set(rotationKey, {
              index: servedIndex,
              consecutiveUseCount: 0,
              seq: live.seq,
            });
          });
        }
        return result;
      }

      // Read response body once for all downstream classification — avoids up to
      // 4 independent clones when the response must not advance the combo.
      let bodyText = "";
      let bodyJson = null;
      try {
        bodyText = await result.clone().text();
        try { bodyJson = JSON.parse(bodyText); } catch {}
      } catch {}

      const errorCode = bodyJson?.error?.code || "";
      const errorMessage = bodyJson?.error?.message || "";

      // Proxy-internal errors (e.g. SSE assembly 502) are not upstream faults — return to client.
      if (isProxyInternalError({ errorCode })) {
        log.info("COMBO", `Model ${modelStr} returned proxy-internal ${result.status}, returning to client without advancing`);
        return result;
      }

      // Combo advancement decision based on status code (Req 5.1, 5.3, 5.4, 5.5)
      // Only advance on 429 or 5xx. All other 4xx errors are returned to the client.
      // Special case: zero-connections 404 should advance (Design: "Zero connections" rule).
      if (!shouldComboAdvance(result.status)) {
        // Check for zero-connections 404 — this is provider unavailability, not a client error.
        // The combo should advance past providers with no configured connections.
        const NO_CREDS_PREFIX = "No active credentials for provider:";
        const zeroConns = result.status === 404 && (
          bodyText.includes(NO_CREDS_PREFIX) ||
          errorMessage.startsWith(NO_CREDS_PREFIX)
        );
        // Check for proxy-side model resolution failure (400).
        const resolutionFailed = result.status === 400 && (
          errorMessage.startsWith("Failed to resolve model:") ||
          errorMessage === "Invalid model format" ||
          errorMessage.includes("has no valid model targets configured")
        );
        // Check for provider accounts exhausted (401/403).
        const hasProxyMarker = result.headers.get(PROXY_EXHAUSTED_HEADER) === "1";
        const hasRetryAfter = !!result.headers.get("Retry-After");
        const accountsExhausted = (result.status === 401 || result.status === 403) && (
          errorMessage.includes("All accounts unavailable") ||
          errorMessage.includes("No more accounts available") ||
          errorMessage.includes("Token refresh failed") ||
          errorMessage.startsWith(NO_CREDS_PREFIX) ||
          (hasProxyMarker && hasRetryAfter)
        );

        if (!zeroConns && !resolutionFailed && !accountsExhausted) {
          // 4xx (non-429): Return response directly to client, do NOT advance (Req 5.3)
          log.info("COMBO", `Model ${modelStr} returned ${result.status} (client error), returning to client without advancing`);
          return result;
        }
        if (resolutionFailed) {
          log.info("COMBO", `Model ${modelStr} failed to resolve, advancing to next model`);
        } else if (accountsExhausted) {
          log.info("COMBO", `Model ${modelStr} provider accounts exhausted, advancing to next model`);
        } else {
          // Zero connections detected — treat like unavailability, advance to next model
          log.info("COMBO", `Model ${modelStr} has zero connections, advancing to next model`);
        }
      }

      // 429 or 5xx: Advance to next model in combo.
      // Connection-level cooldown was already applied by handleSingleModel internally
      // (exponential backoff for 429, transient 30s cooldown for 5xx).

      // Extract error info from response for logging and final exhaustion message.
      // Re-use the pre-read body data to avoid an additional clone.
      let errorText = errorMessage || bodyJson?.error?.message || bodyJson?.message || result.statusText || "";
      let retryAfter = bodyJson?.retryAfter || null;

      // unavailableResponse() puts retry hint in the Retry-After header, not the JSON body
      const retryAfterHeader = result.headers.get("Retry-After");
      if (retryAfterHeader) {
        const retryAfterSec = parseInt(retryAfterHeader, 10);
        if (!Number.isNaN(retryAfterSec) && retryAfterSec > 0) {
          const fromHeader = new Date(Date.now() + retryAfterSec * 1000).toISOString();
          if (!retryAfter || new Date(fromHeader) < new Date(retryAfter)) {
            retryAfter = fromHeader;
          }
        }
      }

      // Track earliest retryAfter across all combo models
      if (retryAfter && (!earliestRetryAfter || new Date(retryAfter) < new Date(earliestRetryAfter))) {
        earliestRetryAfter = retryAfter;
      }

      // Normalize error text to string (Worker-safe)
      if (typeof errorText !== "string") {
        try { errorText = JSON.stringify(errorText); } catch { errorText = String(errorText); }
      }

      // Record last error/status for exhaustion response
      lastError = errorText || String(result.status);
      lastStatus = result.status;
      log.warn("COMBO", `Model ${modelStr} failed (${result.status}), advancing to next model`, { status: result.status });
    } catch (error) {
      // Unexpected exceptions (network errors, etc.) — treat like 5xx, advance to next model
      lastError = error.message || String(error);
      lastStatus = 503;
      log.warn("COMBO", `Model ${modelStr} threw error, advancing to next model`, { error: lastError });
    }
  }

  // All models exhausted (Req 5.6) — restore round-robin reservation if nothing succeeded
  if (comboStrategy === "round-robin" && rotationSnapshot && models && models.length > 1) {
    const rotationKey = comboName || "__default__";
    await withComboRotationLock(comboName, async () => {
      const live = comboRotationState.get(rotationKey);
      // Only undo this request's reservation — concurrent successes may have advanced state.
      if (live && live.seq === rotationSeq) {
        comboRotationState.set(rotationKey, rotationSnapshot);
      }
    });
  }

  const msg = lastError || "All combo models unavailable";
  const status = lastStatus || 503;
  // Use 503 (Service Unavailable) — all providers in the combo are unavailable
  const finalStatus = status >= 500 ? status : 503;

  if (earliestRetryAfter) {
    const retryHuman = formatRetryAfter(earliestRetryAfter);
    log.warn("COMBO", `All models exhausted | ${msg} (${retryHuman})`);
    return unavailableResponse(finalStatus, msg, earliestRetryAfter, retryHuman);
  }

  const minRetryAt = new Date(Date.now() + MIN_RETRY_DELAY_MS).toISOString();
  const retryHuman = formatRetryAfter(minRetryAt);
  log.warn("COMBO", `All models exhausted | ${msg} (${retryHuman})`);
  return unavailableResponse(finalStatus, msg, minRetryAt, retryHuman);
}

// --- Fusion combo strategy (local panel + judge synthesis) ---

const TOOL_CALL_PREFIX = "[Called tools: ";
const TOOL_RESULT_PREFIX = "[Tool result: ";

function flattenToolHistory(messages) {
  return messages
    .filter((msg) => msg)
    .map((msg) => {
      if (msg.role === "tool" || msg.role === "function") {
        return { role: "assistant", content: `${TOOL_RESULT_PREFIX}${extractTextContent(msg.content) || String(msg.content ?? "")}]` };
      }
      if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
        const { tool_calls, ...rest } = msg;
        const names = tool_calls.map((c) => c?.function?.name || c?.name || "tool").join(", ");
        const base = extractTextContent(rest.content) || (typeof rest.content === "string" ? rest.content : "");
        return { ...rest, content: `${base}${base ? "\n" : ""}${TOOL_CALL_PREFIX}${names}]` };
      }
      return msg;
    });
}

function extractPanelText(json) {
  if (!json || typeof json !== "object") return "";

  const choice = json.choices?.[0];
  if (choice) {
    const msg = choice.message ?? choice.delta ?? {};
    const t = extractTextContent(msg.content);
    if (t.trim()) return t;
    if (typeof choice.text === "string" && choice.text.trim()) return choice.text;
  }

  const claudeText = extractTextContent(json.content);
  if (claudeText.trim()) return claudeText;

  const parts = json.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    const t = parts.map((p) => p?.text || "").join("");
    if (t.trim()) return t;
  }

  if (Array.isArray(json.output)) {
    const t = json.output
      .flatMap((o) => (Array.isArray(o.content) ? o.content.map((c) => c?.text || "") : []))
      .join("");
    if (t.trim()) return t;
  }

  return "";
}

function appendUserTurn(body, text) {
  const next = { ...body };
  if (Array.isArray(body.messages)) {
    next.messages = [...body.messages, { role: "user", content: text }];
  } else if (Array.isArray(body.input)) {
    next.input = [...body.input, { role: "user", content: text }];
  } else if (Array.isArray(body.contents)) {
    next.contents = [...body.contents, { role: "user", parts: [{ text }] }];
  } else {
    next.messages = [{ role: "user", content: text }];
  }
  return next;
}

function buildJudgePrompt(answers) {
  const panel = answers
    .map((a, i) => `[Source ${i + 1}]\n${a.text}`)
    .join("\n\n");

  return [
    `You are the JUDGE in a model-fusion panel. ${answers.length} expert models independently answered the user's most recent request. Their responses are below, anonymized by source.`,
    "",
    "Do NOT mention that multiple models were used, and do NOT refer to the sources. Produce ONE authoritative final answer addressed directly to the user.",
    "",
    "First, internally analyze the panel along these dimensions: consensus (points most sources agree on — treat as higher-confidence), contradictions (where they disagree — resolve with your own judgment), partial coverage, unique insights only one source surfaced, and blind spots every source missed. Then write the best possible final answer grounded in that analysis — more complete and correct than any single response, with no filler.",
    "",
    "=== PANEL RESPONSES ===",
    panel,
    "=== END PANEL RESPONSES ===",
    "",
    "Now write the final answer to the user's original request.",
  ].join("\n");
}

const FUSION_DEFAULTS = {
  minPanel: 2,
  stragglerGraceMs: 8000,
  panelHardTimeoutMs: 90000,
};

function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ __timeout: true }), ms);
    Promise.resolve(promise)
      .then((v) => { clearTimeout(t); resolve(v); })
      .catch((e) => { clearTimeout(t); resolve({ __error: e }); });
  });
}

function collectPanel(calls, { minPanel, stragglerGraceMs, panelHardTimeoutMs }) {
  return new Promise((resolve) => {
    const out = new Array(calls.length);
    let settled = 0;
    let ok = 0;
    let finished = false;
    let graceTimer = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(hardTimer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve(out);
    };
    const hardTimer = setTimeout(finish, panelHardTimeoutMs);
    calls.forEach((p, i) => {
      Promise.resolve(p)
        .then((v) => { out[i] = v; })
        .catch((e) => { out[i] = { __error: e }; })
        .finally(() => {
          settled++;
          if (out[i] && out[i].ok) ok++;
          if (settled === calls.length) return finish();
          if (ok >= minPanel && !graceTimer) graceTimer = setTimeout(finish, stragglerGraceMs);
        });
    });
  });
}

export async function handleFusionChat({ body, models, handleSingleModel, log, comboName, judgeModel, tuning }) {
  const panel = Array.isArray(models) ? models.filter(Boolean) : [];
  if (panel.length === 0) {
    return new Response(
      JSON.stringify({ error: { message: "Fusion combo has no models" } }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  if (panel.length === 1) {
    return handleSingleModel(body, panel[0]);
  }

  const cfg = { ...FUSION_DEFAULTS, ...(tuning || {}) };
  const minPanel = Math.min(Math.max(2, cfg.minPanel), panel.length);
  const judge = judgeModel && judgeModel.trim() ? judgeModel.trim() : panel[0];
  log.info("FUSION", `Combo "${comboName}" | panel=${panel.length} [${panel.join(", ")}] | judge=${judge} | quorum=${minPanel}`);

  const { tools, tool_choice, ...rest } = body;
  const panelBody = { ...rest, stream: false };

  if (Array.isArray(panelBody.messages)) {
    panelBody.messages = flattenToolHistory(panelBody.messages);
  } else if (Array.isArray(panelBody.input)) {
    panelBody.input = flattenToolHistory(panelBody.input);
  }

  const t0 = Date.now();
  const calls = panel.map((m) => withTimeout(handleSingleModel(panelBody, m, true), cfg.panelHardTimeoutMs));
  const settled = await collectPanel(calls, { ...cfg, minPanel });
  log.info("FUSION", `fan-out collected in ${Date.now() - t0}ms`);

  const answers = [];
  for (let i = 0; i < settled.length; i++) {
    const res = settled[i];
    const model = panel[i];
    if (!res) { log.warn("FUSION", `Panel ${model} dropped (straggler/timeout)`); continue; }
    if (res.__timeout) { log.warn("FUSION", `Panel ${model} timed out`); continue; }
    if (res.__error) { log.warn("FUSION", `Panel ${model} threw`, { error: res.__error?.message || String(res.__error) }); continue; }
    if (!res.ok) { log.warn("FUSION", `Panel ${model} failed`, { status: res.status }); continue; }
    try {
      const json = await res.clone().json();
      const text = extractPanelText(json);
      if (text) {
        answers.push({ model, text });
        log.info("FUSION", `Panel ${model} ok (${text.length} chars)`);
      } else {
        log.warn("FUSION", `Panel ${model} returned empty content`);
      }
    } catch (e) {
      log.warn("FUSION", `Panel ${model} unparseable`, { error: e.message || String(e) });
    }
  }

  if (answers.length === 0) {
    log.warn("FUSION", "All panel models failed");
    return new Response(
      JSON.stringify({ error: { message: "All fusion panel models failed" } }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }
  if (answers.length === 1) {
    log.info("FUSION", `Only ${answers[0].model} succeeded — answering directly (no fusion)`);
    return handleSingleModel(body, answers[0].model);
  }

  const judgeBody = appendUserTurn(body, buildJudgePrompt(answers));
  log.info("FUSION", `Judging ${answers.length} answers with ${judge}`);
  return handleSingleModel(judgeBody, judge);
}
