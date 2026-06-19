// Public API barrel — all DB functions
import { getAdapter } from "./driver.js";
import { stringifyJson, parseJson } from "./helpers/jsonCol.js";

// Settings
export {
  getSettings, getSettingsSafe, updateSettings, isCloudEnabled, getCloudUrl, exportSettings,
} from "./repos/settingsRepo.js";

// Provider connections
export {
  getProviderConnections, getProviderConnectionById,
  createProviderConnection, updateProviderConnection,
  deleteProviderConnection, deleteProviderConnectionsByProvider,
  reorderProviderConnections, cleanupProviderConnections,
  swapProviderConnectionPriorities,
} from "./repos/connectionsRepo.js";

// Provider nodes
export {
  getProviderNodes, getProviderNodeById,
  createProviderNode, updateProviderNode, deleteProviderNode,
} from "./repos/nodesRepo.js";

// Proxy pools
export {
  getProxyPools, getProxyPoolById,
  createProxyPool, updateProxyPool, deleteProxyPool,
} from "./repos/proxyPoolsRepo.js";

// API keys
export {
  getApiKeys, getApiKeyById, createApiKey, updateApiKey, deleteApiKey, validateApiKey,
} from "./repos/apiKeysRepo.js";

// Combos
export {
  getCombos, getComboById, getComboByName,
  createCombo, updateCombo, deleteCombo,
} from "./repos/combosRepo.js";

// Aliases (model + custom + mitm)
export {
  getModelAliases, setModelAlias, deleteModelAlias,
  getCustomModels, addCustomModel, deleteCustomModel,
  getMitmAlias, setMitmAliasAll,
} from "./repos/aliasRepo.js";

// Pricing
export {
  getPricing, getPricingForModel, getUserPricingOverrides,
  updatePricing, resetPricing, resetAllPricing,
} from "./repos/pricingRepo.js";

// Disabled models
export {
  getDisabledModels, getDisabledByProvider, disableModels, enableModels,
} from "./repos/disabledModelsRepo.js";

// Usage
export {
  statsEmitter, trackPendingRequest, getPendingRequestTotal, getActiveRequests,
  saveRequestUsage, getUsageHistory, getUsageStats, getChartData,
  appendRequestLog, getRecentLogs, getProviderCacheStats,
} from "./repos/usageRepo.js";

// Request details
export {
  saveRequestDetail, getRequestDetails, getRequestDetailById,
} from "./repos/requestDetailsRepo.js";

// Export/import full DB
export async function exportDb() {
  const db = await getAdapter();
  const { exportSettings } = await import("./repos/settingsRepo.js");

  const out = {
    settings: await exportSettings(),
    providerConnections: db.all(`SELECT * FROM providerConnections`).map((r) => ({ ...parseJson(r.data, {}), id: r.id, provider: r.provider, authType: r.authType, name: r.name, email: r.email, priority: r.priority, isActive: r.isActive === 1, createdAt: r.createdAt, updatedAt: r.updatedAt })),
    providerNodes: db.all(`SELECT * FROM providerNodes`).map((r) => ({ ...parseJson(r.data, {}), id: r.id, type: r.type, name: r.name, createdAt: r.createdAt, updatedAt: r.updatedAt })),
    proxyPools: db.all(`SELECT * FROM proxyPools`).map((r) => ({ ...parseJson(r.data, {}), id: r.id, isActive: r.isActive === 1, testStatus: r.testStatus, createdAt: r.createdAt, updatedAt: r.updatedAt })),
    apiKeys: db.all(`SELECT * FROM apiKeys`).map((r) => ({ id: r.id, key: r.key, name: r.name, machineId: r.machineId, isActive: r.isActive === 1, createdAt: r.createdAt })),
    combos: db.all(`SELECT * FROM combos`).map((r) => ({ id: r.id, name: r.name, kind: r.kind, models: parseJson(r.models, []), createdAt: r.createdAt, updatedAt: r.updatedAt })),
    modelAliases: {},
    customModels: [],
    mitmAlias: {},
    pricing: {},
    disabledModels: {},
  };

  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'modelAliases'`)) out.modelAliases[r.key] = parseJson(r.value);
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'customModels'`)) out.customModels.push(parseJson(r.value));
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'mitmAlias'`)) out.mitmAlias[r.key] = parseJson(r.value);
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'pricing'`)) out.pricing[r.key] = parseJson(r.value);
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'disabledModels'`)) out.disabledModels[r.key] = parseJson(r.value);

  out.disabledModels = {};
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'disabledModels'`)) {
    out.disabledModels[r.key] = parseJson(r.value, []);
  }

  out.usageHistory = db.all(`SELECT * FROM usageHistory ORDER BY timestamp ASC`);
  out.usageDaily = db.all(`SELECT * FROM usageDaily`).map((r) => ({
    dateKey: r.dateKey,
    data: parseJson(r.data, {}),
  }));
  out.requestDetails = db.all(`SELECT * FROM requestDetails`).map((r) => ({
    ...parseJson(r.data, {}),
    id: r.id,
    timestamp: r.timestamp,
    provider: r.provider,
    model: r.model,
    connectionId: r.connectionId,
    status: r.status,
  }));

  return out;
}

const IMPORT_ARRAY_SECTIONS = [
  "providerConnections",
  "providerNodes",
  "proxyPools",
  "apiKeys",
  "combos",
  "customModels",
];

const IMPORT_OBJECT_SECTIONS = [
  "settings",
  "modelAliases",
  "mitmAlias",
  "pricing",
  "disabledModels",
];

const IMPORT_REQUIRED_STRING_FIELDS = {
  providerConnections: ["id", "provider"],
  providerNodes: ["id"],
  proxyPools: ["id"],
  apiKeys: ["id", "key"],
  combos: ["id", "name"],
  customModels: ["providerAlias", "id"],
};

function assertImportRowObject(section, row, index) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new Error(`Invalid database payload: ${section}[${index}] must be an object`);
  }
}

function assertRequiredStringFields(section, row, index) {
  for (const field of IMPORT_REQUIRED_STRING_FIELDS[section] || []) {
    if (typeof row[field] !== "string" || row[field].trim() === "") {
      throw new Error(`Invalid database payload: ${section}[${index}].${field} must be a non-empty string`);
    }
  }
}

function validateImportPayload(payload) {
  for (const key of IMPORT_ARRAY_SECTIONS) {
    if (payload[key] != null && !Array.isArray(payload[key])) {
      throw new Error(`Invalid database payload: ${key} must be an array`);
    }
    for (const [index, row] of (payload[key] || []).entries()) {
      assertImportRowObject(key, row, index);
      assertRequiredStringFields(key, row, index);
    }
  }
  for (const key of IMPORT_OBJECT_SECTIONS) {
    if (payload[key] != null && (typeof payload[key] !== "object" || Array.isArray(payload[key]))) {
      throw new Error(`Invalid database payload: ${key} must be an object`);
    }
  }

  const hasContent =
    (payload.settings && typeof payload.settings === "object") ||
    (Array.isArray(payload.providerConnections) && payload.providerConnections.length > 0) ||
    (Array.isArray(payload.providerNodes) && payload.providerNodes.length > 0) ||
    (Array.isArray(payload.proxyPools) && payload.proxyPools.length > 0) ||
    (Array.isArray(payload.apiKeys) && payload.apiKeys.length > 0) ||
    (Array.isArray(payload.combos) && payload.combos.length > 0) ||
    (payload.modelAliases && Object.keys(payload.modelAliases).length > 0) ||
    (Array.isArray(payload.customModels) && payload.customModels.length > 0) ||
    (payload.mitmAlias && Object.keys(payload.mitmAlias).length > 0) ||
    (payload.pricing && Object.keys(payload.pricing).length > 0) ||
    (payload.disabledModels && Object.keys(payload.disabledModels).length > 0);

  if (!hasContent) {
    throw new Error(
      "Invalid database payload: must include at least one non-empty section (replace-only import)",
    );
  }
}

export async function importDb(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid database payload");
  }
  validateImportPayload(payload);

  const db = await getAdapter();

  db.transaction(() => {
    // Wipe config tables (keep _meta). Observability tables (usageHistory,
    // usageDaily, requestDetails) are intentionally NOT wiped: they are not
    // part of the export payload (exportDb omits them by design — they can be
    // large), so a config-only import must preserve historical usage/details
    // rather than silently destroying them. If a payload explicitly includes
    // those sections they are merged below.
    db.run(`DELETE FROM settings`);
    db.run(`DELETE FROM providerConnections`);
    db.run(`DELETE FROM providerNodes`);
    db.run(`DELETE FROM proxyPools`);
    db.run(`DELETE FROM apiKeys`);
    db.run(`DELETE FROM combos`);
    db.run(`DELETE FROM kv WHERE scope IN ('modelAliases', 'customModels', 'mitmAlias', 'pricing', 'disabledModels')`);

    // Settings
    if (payload.settings) {
      db.run(`INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`, [stringifyJson(payload.settings)]);
    }

    for (const c of payload.providerConnections || []) {
      const { id, provider, authType, name, email, priority, isActive, createdAt, updatedAt, ...rest } = c;
      db.run(
        `INSERT OR REPLACE INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, provider, authType || "oauth", name || null, email || null, priority ?? null, isActive === false ? 0 : 1, stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
      );
    }
    for (const n of payload.providerNodes || []) {
      const { id, type, name, createdAt, updatedAt, ...rest } = n;
      db.run(
        `INSERT OR REPLACE INTO providerNodes(id, type, name, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [id, type || null, name || null, stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
      );
    }
    for (const p of payload.proxyPools || []) {
      const { id, isActive, testStatus, createdAt, updatedAt, ...rest } = p;
      db.run(
        `INSERT OR REPLACE INTO proxyPools(id, isActive, testStatus, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [id, isActive === false ? 0 : 1, testStatus || "unknown", stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
      );
    }
    for (const k of payload.apiKeys || []) {
      db.run(
        `INSERT OR REPLACE INTO apiKeys(id, key, name, machineId, isActive, createdAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [k.id, k.key, k.name || null, k.machineId || null, k.isActive === false ? 0 : 1, k.createdAt || new Date().toISOString()]
      );
    }
    for (const c of payload.combos || []) {
      db.run(
        `INSERT OR REPLACE INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [c.id, c.name, c.kind || null, stringifyJson(c.models || []), c.createdAt || new Date().toISOString(), c.updatedAt || new Date().toISOString()]
      );
    }
    for (const [a, m] of Object.entries(payload.modelAliases || {})) {
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('modelAliases', ?, ?)`, [a, stringifyJson(m)]);
    }
    for (const m of payload.customModels || []) {
      const k = `${m.providerAlias}|${m.id}|${m.type || "llm"}`;
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('customModels', ?, ?)`, [k, stringifyJson(m)]);
    }
    for (const [tool, mappings] of Object.entries(payload.mitmAlias || {})) {
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('mitmAlias', ?, ?)`, [tool, stringifyJson(mappings || {})]);
    }
    for (const [provider, models] of Object.entries(payload.pricing || {})) {
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('pricing', ?, ?)`, [provider, stringifyJson(models || {})]);
    }
    for (const [providerAlias, ids] of Object.entries(payload.disabledModels || {})) {
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('disabledModels', ?, ?)`, [providerAlias, stringifyJson(ids || [])]);
    }
    for (const row of payload.usageHistory || []) {
      db.run(
        `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.timestamp, row.provider || null, row.model || null,
          row.connectionId || null, row.apiKey || null, row.endpoint || null,
          row.promptTokens || 0, row.completionTokens || 0, row.cost || 0,
          row.status || "ok", stringifyJson(row.tokens || {}), stringifyJson(row.meta || {}),
        ]
      );
    }
    for (const row of payload.usageDaily || []) {
      db.run(
        `INSERT OR REPLACE INTO usageDaily(dateKey, data) VALUES(?, ?)`,
        [row.dateKey, stringifyJson(row.data || {})]
      );
    }
    for (const row of payload.requestDetails || []) {
      const record = { ...row };
      const { id, timestamp, provider, model, connectionId, status } = record;
      db.run(
        `INSERT OR REPLACE INTO requestDetails(id, timestamp, provider, model, connectionId, status, data) VALUES(?, ?, ?, ?, ?, ?, ?)`,
        [id, timestamp, provider || null, model || null, connectionId || null, status || null, stringifyJson(record)]
      );
    }
  });

  return await exportDb();
}

// Eager init helper (optional)
export async function initDb() {
  await getAdapter();
}
