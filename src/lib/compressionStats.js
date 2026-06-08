import { getMeta, setMeta } from "./db/helpers/metaStore.js";
import { getAdapter } from "./db/driver.js";

const META_KEY = "compressionStats";
const TOOL_IDS = ["rtk", "caveman", "headroom"];
let writeQueue = Promise.resolve();

function estimateTokensSaved(bytesSaved) {
  return Math.round(toNumber(bytesSaved) / 4);
}

function canEstimateTokenSavings(tool, bytesSaved) {
  return tool !== "caveman" && toNumber(bytesSaved) > 0;
}

function emptyToolStats() {
  return {
    requests: 0,
    hits: 0,
    bytesBefore: 0,
    bytesAfter: 0,
    bytesSaved: 0,
    estimatedTokensSaved: 0,
    tokenSavingsAvailable: false,
    lastUsed: null,
    lastDetail: "",
  };
}

function emptyStats() {
  return {
    updatedAt: null,
    tools: Object.fromEntries(TOOL_IDS.map((tool) => [tool, emptyToolStats()])),
  };
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function normalizeStats(value) {
  const base = emptyStats();
  const parsed = typeof value === "string" && value
    ? JSON.parse(value)
    : (value && typeof value === "object" ? value : {});

  base.updatedAt = parsed.updatedAt || null;
  for (const tool of TOOL_IDS) {
    const input = parsed.tools?.[tool] || {};
    const bytesSaved = toNumber(input.bytesSaved);
    const tokenSavingsAvailable = typeof input.tokenSavingsAvailable === "boolean"
      ? input.tokenSavingsAvailable
      : canEstimateTokenSavings(tool, bytesSaved);
    base.tools[tool] = {
      requests: toNumber(input.requests),
      hits: toNumber(input.hits),
      bytesBefore: toNumber(input.bytesBefore),
      bytesAfter: toNumber(input.bytesAfter),
      bytesSaved,
      estimatedTokensSaved: tokenSavingsAvailable ? estimateTokensSaved(bytesSaved) : 0,
      tokenSavingsAvailable,
      lastUsed: input.lastUsed || null,
      lastDetail: typeof input.lastDetail === "string" ? input.lastDetail : "",
    };
  }
  return base;
}

export async function getCompressionStats() {
  try {
    return normalizeStats(await getMeta(META_KEY, null));
  } catch {
    return emptyStats();
  }
}

export async function recordCompressionStats(tool, event = {}) {
  if (!TOOL_IDS.includes(tool)) return getCompressionStats();

  const nextWrite = writeQueue.catch(() => {}).then(async () => {
    const stats = await getCompressionStats();
    const target = stats.tools[tool];
    const bytesBefore = toNumber(event.bytesBefore);
    const bytesAfter = toNumber(event.bytesAfter);
    const explicitSaved = event.bytesSaved == null ? null : toNumber(event.bytesSaved);
    const bytesSaved = explicitSaved == null ? Math.max(0, bytesBefore - bytesAfter) : explicitSaved;
    const hits = toNumber(event.hits ?? (bytesSaved > 0 || event.hit ? 1 : 0));
    const requests = toNumber(event.requests ?? 1) || 1;
    const now = new Date().toISOString();

    target.requests += requests;
    target.hits += hits;
    target.bytesBefore += bytesBefore;
    target.bytesAfter += bytesAfter;
    target.bytesSaved += bytesSaved;
    target.tokenSavingsAvailable = canEstimateTokenSavings(tool, target.bytesSaved);
    target.estimatedTokensSaved = target.tokenSavingsAvailable
      ? estimateTokensSaved(target.bytesSaved)
      : 0;
    target.lastUsed = now;
    if (typeof event.detail === "string") target.lastDetail = event.detail;
    stats.updatedAt = now;

    await setMeta(META_KEY, JSON.stringify(stats));
    return stats;
  });

  writeQueue = nextWrite.catch(() => {});
  return nextWrite.catch(async (err) => {
    try {
      console.error("[compressionStats] Failed to record stats:", err.message);
    } catch {
      // Continue unconditionally if logging also fails (Req 14.4)
    }
    return getCompressionStats();
  });
}

export async function resetCompressionStats() {
  const stats = emptyStats();
  await setMeta(META_KEY, JSON.stringify(stats));
  return stats;
}


/**
 * Save an individual compression stats record to the SQLite compressionStats table.
 * This writes a per-request row (as opposed to the aggregated JSON blob in _meta).
 *
 * @param {object} record
 * @param {string} record.subsystem - 'rtk' | 'headroom' | 'caveman'
 * @param {number} record.bytesBefore - bytes before compression
 * @param {number} record.bytesAfter - bytes after compression
 * @param {string} [record.filterHits] - JSON string of filter names (optional)
 * @param {string} [record.level] - Caveman intensity level (optional)
 * @param {string} [record.timestamp] - ISO8601 timestamp (defaults to now)
 */
export async function saveCompressionStats(record) {
  try {
    const db = await getAdapter();
    const timestamp = record.timestamp || new Date().toISOString();
    const subsystem = record.subsystem;
    const bytesBefore = Number(record.bytesBefore) || 0;
    const bytesAfter = Number(record.bytesAfter) || 0;
    const filterHits = record.filterHits || null;
    const level = record.level || null;

    await db.run(
      `INSERT INTO compressionStats(timestamp, subsystem, bytes_before, bytes_after, filter_hits, level) VALUES(?, ?, ?, ?, ?, ?)`,
      [timestamp, subsystem, bytesBefore, bytesAfter, filterHits, level]
    );
  } catch (err) {
    // Stats write failure must never interrupt the request (Req 14.3)
    try {
      console.error("[compressionStats] Failed to save stats record:", err.message);
    } catch {
      // If logging fails, still continue unconditionally (Req 14.4)
    }
  }
}

/**
 * Retrieve compression stats records from the SQLite table.
 * @param {object} [filter]
 * @param {string} [filter.subsystem] - filter by subsystem
 * @param {string} [filter.since] - ISO8601 timestamp lower bound
 * @param {number} [filter.limit] - max rows to return (default 100)
 * @returns {Promise<Array>}
 */
export async function clearCompressionHistory() {
  try {
    const db = await getAdapter();
    const row = db.get(`SELECT COUNT(*) AS count FROM compressionStats`);
    const deleted = row?.count || 0;
    db.run(`DELETE FROM compressionStats`);
    return deleted;
  } catch (err) {
    try {
      console.error("[compressionStats] Failed to clear history:", err.message);
    } catch { /* continue */ }
    return 0;
  }
}

export async function getFilterLeaderboard({ limit = 20, since } = {}) {
  try {
    const db = await getAdapter();
    const conds = [];
    const params = [];
    if (since) {
      conds.push("timestamp >= ?");
      params.push(since);
    }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const rows = db.all(
      `SELECT filter_hits, bytes_before, bytes_after FROM compressionStats ${where} ORDER BY id DESC LIMIT 5000`,
      params
    );

    const totals = {};
    for (const row of rows) {
      if (!row.filter_hits) continue;
      let filters = [];
      try {
        filters = JSON.parse(row.filter_hits);
      } catch {
        continue;
      }
      const saved = Math.max(0, (Number(row.bytes_before) || 0) - (Number(row.bytes_after) || 0));
      for (const filter of filters) {
        if (!filter) continue;
        if (!totals[filter]) totals[filter] = { filter, hits: 0, bytesSaved: 0 };
        totals[filter].hits += 1;
        totals[filter].bytesSaved += saved;
      }
    }

    return Object.values(totals)
      .sort((a, b) => b.bytesSaved - a.bytesSaved)
      .slice(0, limit);
  } catch {
    return [];
  }
}

export async function getCompressionStatsHistory(filter = {}) {
  try {
    const db = await getAdapter();
    const conds = [];
    const params = [];

    if (filter.subsystem) {
      conds.push("subsystem = ?");
      params.push(filter.subsystem);
    }
    if (filter.since) {
      conds.push("timestamp >= ?");
      params.push(filter.since);
    }

    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const limit = filter.limit || 100;
    params.push(limit);

    return db.all(
      `SELECT id, timestamp, subsystem, bytes_before, bytes_after, filter_hits, level FROM compressionStats ${where} ORDER BY id DESC LIMIT ?`,
      params
    );
  } catch {
    return [];
  }
}
