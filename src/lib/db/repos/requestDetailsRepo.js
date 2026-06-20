import { getAdapter, getAdapterSync } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { sanitizeValue as sanitizeForPersistence } from "@/shared/utils/redaction.js";

const DEFAULT_MAX_RECORDS = 200;
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const DEFAULT_MAX_JSON_SIZE = 5 * 1024;
const CONFIG_CACHE_TTL_MS = 5000;

let cachedConfig = null;
let cachedConfigTs = 0;

async function getObservabilityConfig() {
  if (cachedConfig && (Date.now() - cachedConfigTs) < CONFIG_CACHE_TTL_MS) return cachedConfig;
  try {
    const { getSettings } = await import("./settingsRepo.js");
    const settings = await getSettings();
    const envEnabled = process.env.OBSERVABILITY_ENABLED !== "false";
    const enabled = typeof settings.enableObservability === "boolean"
      ? settings.enableObservability
      : envEnabled;
    cachedConfig = {
      enabled,
      maxRecords: settings.observabilityMaxRecords || parseInt(process.env.OBSERVABILITY_MAX_RECORDS || String(DEFAULT_MAX_RECORDS), 10),
      batchSize: settings.observabilityBatchSize || parseInt(process.env.OBSERVABILITY_BATCH_SIZE || String(DEFAULT_BATCH_SIZE), 10),
      flushIntervalMs: settings.observabilityFlushIntervalMs || parseInt(process.env.OBSERVABILITY_FLUSH_INTERVAL_MS || String(DEFAULT_FLUSH_INTERVAL_MS), 10),
      maxJsonSize: (settings.observabilityMaxJsonSize || parseInt(process.env.OBSERVABILITY_MAX_JSON_SIZE || "5", 10)) * 1024,
    };
  } catch {
    cachedConfig = {
      enabled: false,
      maxRecords: DEFAULT_MAX_RECORDS,
      batchSize: DEFAULT_BATCH_SIZE,
      flushIntervalMs: DEFAULT_FLUSH_INTERVAL_MS,
      maxJsonSize: DEFAULT_MAX_JSON_SIZE,
    };
  }
  cachedConfigTs = Date.now();
  return cachedConfig;
}

let writeBuffer = [];
let flushTimer = null;
let isFlushing = false;

function generateDetailId(model) {
  const timestamp = new Date().toISOString();
  const random = Math.random().toString(36).substring(2, 8);
  const modelPart = model ? model.replace(/[^a-zA-Z0-9-]/g, "-") : "unknown";
  return `${timestamp}-${random}-${modelPart}`;
}

function truncateField(obj, maxSize) {
  const str = JSON.stringify(obj || {});
  if (str.length > maxSize) {
    return { _truncated: true, _originalSize: str.length, _preview: str.substring(0, 200) };
  }
  return obj || {};
}

function writeItemsToDb(db, items, config) {
  for (const item of items) {
    if (!item.id) item.id = generateDetailId(item.model);
    if (!item.timestamp) item.timestamp = new Date().toISOString();
    const request = sanitizeForPersistence(item.request);
    const providerRequest = sanitizeForPersistence(item.providerRequest);
    const providerResponse = sanitizeForPersistence(item.providerResponse);
    const response = sanitizeForPersistence(item.response);

    const record = {
      id: item.id,
      provider: item.provider || null,
      model: item.model || null,
      connectionId: item.connectionId || null,
      timestamp: item.timestamp,
      status: item.status || null,
      latency: item.latency || {},
      tokens: item.tokens || {},
      request: truncateField(request, config.maxJsonSize),
      providerRequest: truncateField(providerRequest, config.maxJsonSize),
      providerResponse: truncateField(providerResponse, config.maxJsonSize),
      response: truncateField(response, config.maxJsonSize),
    };

    db.run(
      `INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, data) VALUES(?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET timestamp = excluded.timestamp, provider = excluded.provider, model = excluded.model, connectionId = excluded.connectionId, status = excluded.status, data = excluded.data`,
      [record.id, record.timestamp, record.provider, record.model, record.connectionId, record.status, stringifyJson(record)]
    );
  }

  const cnt = db.get(`SELECT COUNT(*) as c FROM requestDetails`);
  if (cnt && cnt.c > config.maxRecords) {
    db.run(
      `DELETE FROM requestDetails WHERE id IN (SELECT id FROM requestDetails ORDER BY timestamp ASC LIMIT ?)`,
      [cnt.c - config.maxRecords]
    );
  }
}

async function flushToDatabase() {
  if (isFlushing) return;
  if (writeBuffer.length === 0) return;
  isFlushing = true;
  let items = null;
  try {
    // Drain entire buffer (loop in case more pushed during await)
    while (writeBuffer.length > 0) {
      items = writeBuffer.splice(0, writeBuffer.length);
      const db = await getAdapter();
      const config = await getObservabilityConfig();

      db.transaction(() => {
        writeItemsToDb(db, items, config);
      });
      items = null;
    }
  } catch (e) {
    if (items?.length) writeBuffer = items.concat(writeBuffer);
    console.error("[requestDetailsRepo] Batch write failed:", e);
  } finally {
    isFlushing = false;
  }
}

export async function saveRequestDetail(detail) {
  const config = await getObservabilityConfig();
  if (!config.enabled) return;

  writeBuffer.push(detail);

  // Trigger immediate flush if batch threshold reached.
  // flushToDatabase() drains entire buffer in a loop, so all pushes during await are persisted.
  if (writeBuffer.length >= config.batchSize) {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    flushToDatabase().catch((e) => console.error("[requestDetailsRepo] flush err:", e));
  } else if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushToDatabase().catch(() => {});
    }, config.flushIntervalMs);
    if (typeof flushTimer.unref === "function") flushTimer.unref();
  }
}

export async function getRequestDetails(filter = {}) {
  const db = await getAdapter();
  const conds = [];
  const params = [];

  if (filter.provider) { conds.push("provider = ?"); params.push(filter.provider); }
  if (filter.model) { conds.push("model = ?"); params.push(filter.model); }
  if (filter.connectionId) { conds.push("connectionId = ?"); params.push(filter.connectionId); }
  if (filter.status) { conds.push("status = ?"); params.push(filter.status); }
  if (filter.startDate) {
    const d = new Date(filter.startDate);
    if (Number.isNaN(d.getTime())) throw new Error("Invalid startDate");
    conds.push("timestamp >= ?");
    params.push(d.toISOString());
  }
  if (filter.endDate) {
    const d = new Date(filter.endDate);
    if (Number.isNaN(d.getTime())) throw new Error("Invalid endDate");
    conds.push("timestamp <= ?");
    const ev = filter.endDate;
    params.push(
      typeof ev === "string" && /^\d{4}-\d{2}-\d{2}$/.test(ev.trim())
        ? new Date(`${ev.trim()}T23:59:59.999Z`).toISOString()
        : d.toISOString()
    );
  }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const cntRow = db.get(`SELECT COUNT(*) as c FROM requestDetails ${where}`, params);
  const totalItems = cntRow ? cntRow.c : 0;

  const page = filter.page || 1;
  const pageSize = filter.pageSize || 50;
  const totalPages = Math.ceil(totalItems / pageSize);
  const offset = (page - 1) * pageSize;

  const rows = db.all(
    `SELECT data FROM requestDetails ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  const details = rows.map((r) => parseJson(r.data, {}));

  return {
    details,
    pagination: { page, pageSize, totalItems, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
  };
}

export async function getRequestDetailById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT data FROM requestDetails WHERE id = ?`, [id]);
  return row ? parseJson(row.data, null) : null;
}

// Best-effort synchronous flush of buffered request details. Exposed so the
// application shutdown sequence can invoke it explicitly from a controlled
// point (e.g. the server's beforeExit hook). We do NOT register process-level
// SIGINT/SIGTERM/beforeExit listeners on import: those fire asynchronously and
// cannot reliably await a DB flush, and installing them as a side effect of
// import pollutes the process's signal handling. Callers that want a shutdown
// flush should call this from their own lifecycle hook.
export function flushRequestDetailsSync() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (writeBuffer.length === 0) return;
  let items = null;
  try {
    const db = getAdapterSync();
    const config = cachedConfig || {
      maxRecords: DEFAULT_MAX_RECORDS,
      batchSize: DEFAULT_BATCH_SIZE,
      flushIntervalMs: DEFAULT_FLUSH_INTERVAL_MS,
      maxJsonSize: DEFAULT_MAX_JSON_SIZE,
    };
    items = writeBuffer.splice(0, writeBuffer.length);
    db.transaction(() => {
      writeItemsToDb(db, items, config);
    });
    items = null;
  } catch (e) {
    if (items?.length) writeBuffer = items.concat(writeBuffer);
    console.error("[requestDetailsRepo] sync shutdown flush failed:", e);
  }
}
