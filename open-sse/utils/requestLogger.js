import {
  maskSensitiveHeaders,
  redactSensitiveText,
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
  
  return {
    get sessionPath() { return sessionPath; },
    
    // 1. Log client raw request (before any conversion)
    logClientRawRequest(endpoint, body, headers = {}) {
      writeJsonFile(sessionPath, "1_req_client.json", {
        timestamp: new Date().toISOString(),
        endpoint,
        headers: maskSensitiveHeaders(headers),
        body: sanitizeLogValue(body)
      });
    },
    
    // 2. Log raw request from client (after initial conversion like responsesApi)
    logRawRequest(body, headers = {}) {
      writeJsonFile(sessionPath, "2_req_source.json", {
        timestamp: new Date().toISOString(),
        headers: maskSensitiveHeaders(headers),
        body: sanitizeLogValue(body)
      });
    },
    
    // 3. Log OpenAI intermediate format (source → openai)
    logOpenAIRequest(body) {
      writeJsonFile(sessionPath, "3_req_openai.json", {
        timestamp: new Date().toISOString(),
        body: sanitizeLogValue(body)
      });
    },
    
    // 4. Log target format request (openai → target)
    logTargetRequest(url, headers, body) {
      writeJsonFile(sessionPath, "4_req_target.json", {
        timestamp: new Date().toISOString(),
        url,
        headers: maskSensitiveHeaders(headers),
        body: sanitizeLogValue(body)
      });
    },
    
    // 5. Log provider response (for non-streaming or error)
    logProviderResponse(status, statusText, headers, body) {
      const filename = "5_res_provider.json";
      writeJsonFile(sessionPath, filename, {
        timestamp: new Date().toISOString(),
        status,
        statusText,
        headers: maskSensitiveHeaders(headers ? (typeof headers.entries === "function" ? Object.fromEntries(headers.entries()) : headers) : {}),
        body: sanitizeLogValue(body)
      });
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
      writeJsonFile(sessionPath, "7_res_client.json", {
        timestamp: new Date().toISOString(),
        body: sanitizeLogValue(body)
      });
    },
    
    // 7. Append streaming chunk to converted response
    appendConvertedChunk(chunk) {
      queueStreamChunk("7_res_client.txt", chunk);
    },

    flushStreamLogs: flushQueuedStreamLogs,
    
    // 8. Log error (failed or incomplete request)
    logError(error, requestBody = null, logOptions = {}) {
      writeJsonFile(sessionPath, "8_error.json", {
        timestamp: new Date().toISOString(),
        failed: true,
        incomplete: logOptions.incomplete === true,
        passthrough: options.passthrough === true,
        error: redactSensitiveText(error?.message || String(error)),
        stack: error?.stack ? redactSensitiveText(error.stack) : undefined,
        requestBody: sanitizeLogValue(requestBody)
      });
    }
  };
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

export function logError(provider, { error, url, model, requestBody }) {
  if (!fs || !LOGS_DIR) return;
  
  try {
    if (!fs.existsSync(LOGS_DIR)) {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
    }
    
    const date = new Date().toISOString().split("T")[0];
    const logPath = path.join(LOGS_DIR, `${provider}-${date}.log`);
    
    const logEntry = {
      timestamp: new Date().toISOString(),
      type: "error",
      provider,
      model,
      url,
      error: error?.message || String(error),
      stack: error?.stack,
      requestBody
    };
    
    fs.appendFileSync(logPath, JSON.stringify(logEntry) + "\n");
  } catch (err) {
    console.log("[LOG] Failed to write error log:", err.message);
  }
}
