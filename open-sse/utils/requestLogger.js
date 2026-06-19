import {
  maskSensitiveHeaders,
  redactSensitiveText,
  redactSensitiveUrl,
  sanitizeValue as sanitizeLogValue,
} from "../../src/shared/utils/redaction.js";

// Check if running in Node.js environment (has fs module)
const isNode = typeof process !== "undefined" && process.versions?.node && typeof window === "undefined";

// Check if logging is enabled via environment variable (default: false)
const LOGGING_ENABLED = typeof process !== "undefined" && process.env?.ENABLE_REQUEST_LOGS === 'true';

let fs = null;
let path = null;
let LOGS_DIR = null;
let logSessionCounter = 0;

// Lazy load Node.js modules (avoid top-level await)
async function ensureNodeModules() {
  if (!isNode || !LOGGING_ENABLED || fs) return;
  try {
    fs = await import("fs");
    path = await import("path");
    LOGS_DIR = path.join(typeof process !== "undefined" && process.cwd ? process.cwd() : ".", "logs");
  } catch {
    // Running in non-Node environment (Worker, Browser, etc.)
  }
}

// Format timestamp for folder name: 20251228_143045_123
function formatTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const min = pad(date.getMinutes());
  const s = pad(date.getSeconds());
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${y}${m}${d}_${h}${min}${s}_${ms}`;
}

export function formatLogFolderPrefix(sourceFormat, targetFormat, model, { passthrough = false } = {}) {
  const safeModel = (model || "unknown").replace(/[/:]/g, "-");
  const modePrefix = passthrough ? "passthrough_" : "";
  return `${modePrefix}${sourceFormat}_${targetFormat}_${safeModel}`;
}

// Create log session folder: [{passthrough}_]{sourceFormat}_{targetFormat}_{model}_{timestamp}
async function createLogSession(sourceFormat, targetFormat, model, options = {}) {
  await ensureNodeModules();
  if (!fs || !LOGS_DIR) return null;
  
  try {
    if (!fs.existsSync(LOGS_DIR)) {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
    }
    
    const timestamp = formatTimestamp();
    logSessionCounter = (logSessionCounter + 1) % Number.MAX_SAFE_INTEGER;
    const uniqueSuffix = `${timestamp}_${logSessionCounter}`;
    const folderName = `${formatLogFolderPrefix(sourceFormat, targetFormat, model, options)}_${uniqueSuffix}`;
    const sessionPath = path.join(LOGS_DIR, folderName);
    
    fs.mkdirSync(sessionPath, { recursive: true });
    
    return sessionPath;
  } catch (err) {
    console.log("[LOG] Failed to create log session:", err.message);
    return null;
  }
}

// Write JSON file
function writeJsonFile(sessionPath, filename, data) {
  if (!fs || !sessionPath) return;
  
  try {
    const filePath = path.join(sessionPath, filename);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (err) {
    console.log(`[LOG] Failed to write ${filename}:`, err.message);
  }
}

const STREAM_LOG_FLUSH_THRESHOLD_BYTES = 64 * 1024;

// No-op logger when logging is disabled
function createNoOpLogger() {
  return {
    sessionPath: null,
    logClientRawRequest() {},
    logRawRequest() {},
    logOpenAIRequest() {},
    logTargetRequest() {},
    logProviderResponse() {},
    appendProviderChunk() {},
    appendOpenAIChunk() {},
    logConvertedResponse() {},
    appendConvertedChunk() {},
    flushStreamLogs() { return Promise.resolve(); },
    logError() {}
  };
}

/**
 * Create a new log session and return logger functions
 * @param {string} sourceFormat - Source format from client (claude, openai, etc.)
 * @param {string} targetFormat - Target format to provider (antigravity, gemini-cli, etc.)
 * @param {string} model - Model name
 * @returns {Promise<object>} Promise that resolves to logger object with methods to log each stage
 */
export async function createRequestLogger(sourceFormat, targetFormat, model, options = {}) {
  // Return no-op logger if logging is disabled
  if (!LOGGING_ENABLED) {
    return createNoOpLogger();
  }
  
  // Wait for session to be created before returning logger
  const sessionPath = await createLogSession(sourceFormat, targetFormat, model, options);
  const streamBuffers = new Map();
  let streamFlushScheduled = false;
  let streamFlushQueue = Promise.resolve();

  const queueStreamChunk = (filename, chunk) => {
    if (!fs || !sessionPath) return;
    try {
      const redacted = redactSensitiveText(chunk);
      const existing = streamBuffers.get(filename) || { chunks: [], bytes: 0 };
      existing.chunks.push(redacted);
      existing.bytes += Buffer.byteLength(redacted);
      streamBuffers.set(filename, existing);
      if (existing.bytes >= STREAM_LOG_FLUSH_THRESHOLD_BYTES) {
        scheduleStreamFlush();
      }
    } catch {
      // Ignore logging errors
    }
  };

  const drainStreamBuffers = () => {
    const drained = [];
    for (const [filename, buffer] of streamBuffers.entries()) {
      if (!buffer.chunks.length) continue;
      drained.push([filename, buffer.chunks.join("")]);
    }
    streamBuffers.clear();
    return drained;
  };

  const flushStreamLogs = async () => {
    if (!fs || !sessionPath) return;
    const entries = drainStreamBuffers();
    if (!entries.length) return;
    await Promise.all(entries.map(async ([filename, text]) => {
      try {
        await fs.promises.appendFile(path.join(sessionPath, filename), text);
      } catch {
        // Ignore append errors
      }
    }));
  };

  const scheduleStreamFlush = () => {
    if (streamFlushScheduled) return;
    streamFlushScheduled = true;
    queueMicrotask(() => {
      streamFlushScheduled = false;
      streamFlushQueue = streamFlushQueue
        .catch(() => {})
        .then(flushStreamLogs)
        .catch(() => {});
    });
  };

  const flushQueuedStreamLogs = async () => {
    await streamFlushQueue.catch(() => {});
    await flushStreamLogs().catch(() => {});
    await streamFlushQueue.catch(() => {});
  };
  
  const safeWrite = (label, build) => {
    try {
      build();
    } catch (err) {
      // Redaction/serialization of a hostile or pathological body must never
      // fail the request path — log and swallow (optional system).
      console.log(`[LOG] ${label} failed (ignored):`, err?.message || err);
    }
  };

  return {
    get sessionPath() { return sessionPath; },
    
    // 1. Log client raw request (before any conversion)
    logClientRawRequest(endpoint, body, headers = {}) {
      safeWrite("logClientRawRequest", () => writeJsonFile(sessionPath, "1_req_client.json", {
        timestamp: new Date().toISOString(),
        endpoint,
        headers: maskSensitiveHeaders(headers),
        body: sanitizeLogValue(body)
      }));
    },
    
    // 2. Log raw request from client (after initial conversion like responsesApi)
    logRawRequest(body, headers = {}) {
      safeWrite("logRawRequest", () => writeJsonFile(sessionPath, "2_req_source.json", {
        timestamp: new Date().toISOString(),
        headers: maskSensitiveHeaders(headers),
        body: sanitizeLogValue(body)
      }));
    },
    
    // 3. Log OpenAI intermediate format (source → openai)
    logOpenAIRequest(body) {
      safeWrite("logOpenAIRequest", () => writeJsonFile(sessionPath, "3_req_openai.json", {
        timestamp: new Date().toISOString(),
        body: sanitizeLogValue(body)
      }));
    },
    
    // 4. Log target format request (openai → target)
    logTargetRequest(url, headers, body) {
      safeWrite("logTargetRequest", () => writeJsonFile(sessionPath, "4_req_target.json", {
        timestamp: new Date().toISOString(),
        url: redactSensitiveUrl(url),
        headers: maskSensitiveHeaders(headers),
        body: sanitizeLogValue(body)
      }));
    },
    
    // 5. Log provider response (for non-streaming or error)
    logProviderResponse(status, statusText, headers, body) {
      const filename = "5_res_provider.json";
      safeWrite("logProviderResponse", () => writeJsonFile(sessionPath, filename, {
        timestamp: new Date().toISOString(),
        status,
        statusText,
        headers: maskSensitiveHeaders(headers ? (typeof headers.entries === "function" ? Object.fromEntries(headers.entries()) : headers) : {}),
        body: sanitizeLogValue(body)
      }));
    },
    
    // 5. Append streaming chunk to provider response
    appendProviderChunk(chunk) {
      queueStreamChunk("5_res_provider.txt", chunk);
    },
    
    // 6. Append OpenAI intermediate chunks (target → openai)
    appendOpenAIChunk(chunk) {
      queueStreamChunk("6_res_openai.txt", chunk);
    },
    
    // 7. Log converted response to client (for non-streaming)
    logConvertedResponse(body) {
      safeWrite("logConvertedResponse", () => writeJsonFile(sessionPath, "7_res_client.json", {
        timestamp: new Date().toISOString(),
        body: sanitizeLogValue(body)
      }));
    },
    
    // 7. Append streaming chunk to converted response
    appendConvertedChunk(chunk) {
      queueStreamChunk("7_res_client.txt", chunk);
    },

    flushStreamLogs: flushQueuedStreamLogs,
    
    // 8. Log error (failed or incomplete request)
    logError(error, requestBody = null, logOptions = {}) {
      safeWrite("logError", () => writeJsonFile(sessionPath, "8_error.json", {
        timestamp: new Date().toISOString(),
        failed: true,
        incomplete: logOptions.incomplete === true,
        // Per-call override wins; fall back to the logger-wide closure default.
        passthrough: (logOptions.passthrough ?? options.passthrough) === true,
        error: redactSensitiveText(error?.message || String(error)),
        stack: error?.stack ? redactSensitiveText(error.stack) : undefined,
        requestBody: sanitizeLogValue(requestBody)
      }));
    }
  };
}

// Allowed auth-failure reasons (Req 7.3). Any other value is coerced to null so
// a raw header/key can never leak into the summary via this field.
const INBOUND_AUTH_FAILURE_REASONS = new Set(["missing_header", "invalid_key", "malformed_header"]);

/**
 * Write a single structured inbound-request summary entry (Req 7.1–7.5).
 *
 * Emitted once per inbound request on completion (success or error) from the
 * chat handler. Contains exactly the Req 7.1 fields plus the failure-context
 * fields when applicable:
 *   { inboundWire, rawModel, resolvedProviderModelString | null, status }
 *   + on resolution failure: { unresolvedModel, registeredModels }
 *   + on auth failure:       { authFailureReason ∈ {missing_header,invalid_key,malformed_header} }
 *
 * Fail-open (AGENTS.md "optional systems must not break the request path"):
 * gated on ENABLE_REQUEST_LOGS (no-op when disabled) and wrapped so ANY error —
 * including a failure while logging the failure — is swallowed and the request
 * proceeds. Every field is routed through the shared redaction helpers so an
 * Authorization value / bearer token / api key can never reach the log (Req 7.5).
 *
 * @param {object} fields
 * @returns {void} never throws
 */
export function logInboundSummary({
  inboundWire,
  rawModel,
  resolvedModel,
  status,
  authFailureReason,
  unresolvedModel,
  registeredModels,
} = {}) {
  // Gate: no-op when request logging is disabled (Req 7.4 fail-open intent).
  if (!LOGGING_ENABLED) return;
  try {
    const reason = INBOUND_AUTH_FAILURE_REASONS.has(authFailureReason) ? authFailureReason : null;
    const entry = {
      timestamp: new Date().toISOString(),
      type: "inbound_summary",
      // Req 7.1 — required fields. Route free-text through redactSensitiveText
      // and structured values through sanitizeLogValue so no secret slips in via
      // a hostile model string.
      inboundWire: inboundWire == null ? null : redactSensitiveText(inboundWire),
      rawModel: rawModel == null ? null : redactSensitiveText(rawModel),
      resolvedProviderModelString: resolvedModel == null ? null : redactSensitiveText(resolvedModel),
      status: typeof status === "number" ? status : null,
      // Req 7.3 — auth failure reason only (never the key/raw Authorization value).
      authFailureReason: reason,
    };
    // Req 7.2 — resolution-failure context.
    if (unresolvedModel != null) entry.unresolvedModel = redactSensitiveText(unresolvedModel);
    if (registeredModels != null) entry.registeredModels = sanitizeLogValue(registeredModels);

    if (isNode && console?.log) {
      console.log(`[INBOUND] ${JSON.stringify(entry)}`);
    }
  } catch (err) {
    // Swallow EVERYTHING — logging must never break the request path (Req 7.4).
    try {
      console.log("[LOG] logInboundSummary failed (ignored):", err?.message || err);
    } catch {
      // If even logging the failure fails, still continue.
    }
  }
}

// Legacy functions for backward compatibility
export function logRequest() {}
export function logResponse() {}

export async function listRequestLogSessions(limit = 50) {
  await ensureNodeModules();
  if (!fs || !LOGS_DIR) return { enabled: LOGGING_ENABLED, sessions: [] };

  try {
    if (!fs.existsSync(LOGS_DIR)) {
      return { enabled: LOGGING_ENABLED, sessions: [] };
    }
    const entries = fs.readdirSync(LOGS_DIR, { withFileTypes: true });
    const sessions = entries
      .filter((e) => e.isDirectory())
      .map((e) => {
        const sessionPath = path.join(LOGS_DIR, e.name);
        let mtime = null;
        let hasError = false;
        try {
          const stat = fs.statSync(sessionPath);
          mtime = stat.mtime.toISOString();
          hasError = fs.existsSync(path.join(sessionPath, "8_error.json"));
        } catch { /* ignore */ }
        return { name: e.name, mtime, hasError };
      })
      .sort((a, b) => new Date(b.mtime || 0) - new Date(a.mtime || 0))
      .slice(0, limit);

    return { enabled: LOGGING_ENABLED, sessions };
  } catch (err) {
    try {
      console.log("[LOG] Failed to list sessions:", err.message);
    } catch { /* ignore */ }
    return { enabled: LOGGING_ENABLED, sessions: [] };
  }
}

const ALLOWED_LOG_FILES = new Set([
  "1_req_client.json",
  "2_req_source.json",
  "3_req_openai.json",
  "4_req_target.json",
  "5_res_provider.json",
  "5_res_provider.txt",
  "6_res_openai.txt",
  "7_res_client.json",
  "7_res_client.txt",
  "8_error.json",
]);

function sanitizeSessionName(name) {
  if (!name || typeof name !== "string") return null;
  if (name.includes("..") || name.includes("/") || name.includes("\\")) return null;
  if (!/^[\w.-]+$/.test(name)) return null;
  return name;
}

export async function getRequestLogSession(sessionName) {
  await ensureNodeModules();
  if (!fs || !LOGS_DIR) {
    return { enabled: LOGGING_ENABLED, error: "File logging not available" };
  }

  const safe = sanitizeSessionName(sessionName);
  if (!safe) return { enabled: LOGGING_ENABLED, error: "Invalid session name" };

  const sessionPath = path.join(LOGS_DIR, safe);
  if (!fs.existsSync(sessionPath)) {
    return { enabled: LOGGING_ENABLED, error: "Session not found" };
  }

  let mtime = null;
  let hasError = false;
  try {
    const stat = fs.statSync(sessionPath);
    mtime = stat.mtime.toISOString();
    hasError = fs.existsSync(path.join(sessionPath, "8_error.json"));
  } catch { /* ignore */ }

  const files = fs.readdirSync(sessionPath)
    .filter((f) => ALLOWED_LOG_FILES.has(f))
    .sort()
    .map((f) => {
      let size = 0;
      try {
        size = fs.statSync(path.join(sessionPath, f)).size;
      } catch { /* ignore */ }
      return { name: f, size };
    });

  return { enabled: LOGGING_ENABLED, name: safe, mtime, hasError, files };
}

export async function readRequestLogSessionFile(sessionName, fileName) {
  await ensureNodeModules();
  if (!fs || !LOGS_DIR) {
    return { enabled: LOGGING_ENABLED, error: "File logging not available" };
  }

  const safe = sanitizeSessionName(sessionName);
  if (!safe) return { enabled: LOGGING_ENABLED, error: "Invalid session name" };
  if (!fileName || !ALLOWED_LOG_FILES.has(fileName)) {
    return { enabled: LOGGING_ENABLED, error: "Invalid file name" };
  }

  const filePath = path.join(LOGS_DIR, safe, fileName);
  if (!fs.existsSync(filePath)) {
    return { enabled: LOGGING_ENABLED, error: "File not found" };
  }

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const isJson = fileName.endsWith(".json");
    if (isJson) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed?.headers) parsed.headers = maskSensitiveHeaders(parsed.headers);
        return {
          enabled: LOGGING_ENABLED,
          name: safe,
          file: fileName,
          contentType: "json",
          content: JSON.stringify(parsed, null, 2),
        };
      } catch {
        return { enabled: LOGGING_ENABLED, name: safe, file: fileName, contentType: "text", content: raw };
      }
    }
    return { enabled: LOGGING_ENABLED, name: safe, file: fileName, contentType: "text", content: raw };
  } catch (err) {
    return { enabled: LOGGING_ENABLED, error: err.message || "Failed to read file" };
  }
}

// NOTE: A standalone `logError(provider, {...})` export used to live here. It
// wrote url/error/stack/requestBody to disk WITHOUT redaction, unlike the
// session-scoped logError (see createRequestLogger above) which routes every
// field through redactSensitiveText/sanitizeLogValue. It had zero callers, so
// it was removed rather than hardened — a dead export that leaks secrets is
// best deleted. Use createRequestLogger().logError for error logging.
