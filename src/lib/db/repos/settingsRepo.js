import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const DEFAULT_MITM_ROUTER_BASE = "http://localhost:20128";

const DEFAULT_SETTINGS = {
  cloudEnabled: false,
  cloudUrl: "",
  fallbackStrategy: "fill-first",
  tunnelEnabled: false,
  tunnelUrl: "",
  tunnelProvider: "cloudflare",
  tailscaleEnabled: false,
  tailscaleUrl: "",
  stickyRoundRobinLimit: 3,
  providerStrategies: {},
  comboStrategy: "fallback",
  comboStickyRoundRobinLimit: 1,
  comboStrategies: {},
  requireLogin: true,
  requireApiKey: false,
  tunnelDashboardAccess: false,
  authMode: "password",
  oidcIssuerUrl: "",
  oidcClientId: "",
  oidcClientSecret: "",
  oidcScopes: "openid profile email",
  oidcLoginLabel: "Sign in with OIDC",
  enableObservability: true,
  observabilityMaxRecords: 1000,
  observabilityBatchSize: 20,
  observabilityFlushIntervalMs: 5000,
  observabilityMaxJsonSize: 5,
  outboundProxyEnabled: false,
  outboundProxyUrl: "",
  outboundNoProxy: "",
  mitmRouterBaseUrl: DEFAULT_MITM_ROUTER_BASE,
  mitmAutoSetupOnImport: true,
  dnsToolEnabled: {},
  rtkEnabled: true,
  rtkFilterConfig: {
    "git-diff": true,
    "git-status": true,
    "build-output": true,
    "grep": true,
    "find": true,
    "tree": true,
    "ls": true,
    "search-list": true,
    "read-numbered": true,
    "dedup-log": true,
    "smart-truncate": true,
  },
  cavemanEnabled: false,
  cavemanLevel: "full",
  headroomEnabled: false,
  passthroughCompression: false,
};

async function readRaw() {
  const db = await getAdapter();
  const row = db.get(`SELECT data FROM settings WHERE id = 1`);
  return row ? parseJson(row.data, {}) : {};
}

// Merge raw settings with defaults; backward-compat for missing keys
function mergeWithDefaults(raw) {
  const merged = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  for (const [key, defVal] of Object.entries(DEFAULT_SETTINGS)) {
    if (merged[key] === undefined || merged[key] === null) {
      if (
        key === "outboundProxyEnabled" &&
        typeof merged.outboundProxyUrl === "string" &&
        merged.outboundProxyUrl.trim()
      ) {
        merged[key] = true;
      } else {
        merged[key] = defVal;
      }
    }
  }
  return merged;
}

export async function getSettings() {
  const raw = await readRaw();
  return mergeWithDefaults(raw);
}

/** Like getSettings but returns merged defaults instead of throwing when DB is unavailable. */
export async function getSettingsSafe() {
  try {
    return await getSettings();
  } catch {
    return mergeWithDefaults({});
  }
}

function mergeNestedSettingMap(current = {}, incoming = {}) {
  const merged = { ...current };
  for (const [key, value] of Object.entries(incoming)) {
    if (value === null || value === undefined) {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

// Atomic read-merge-write inside transaction (prevents losing concurrent updates)
export async function updateSettings(updates) {
  const db = await getAdapter();
  let next;
  db.transaction(() => {
    const row = db.get(`SELECT data FROM settings WHERE id = 1`);
    const current = row ? parseJson(row.data, {}) : {};
    next = { ...current, ...updates };
    if (Object.prototype.hasOwnProperty.call(updates, "providerStrategies")) {
      next.providerStrategies = mergeNestedSettingMap(
        current.providerStrategies,
        updates.providerStrategies,
      );
    }
    if (Object.prototype.hasOwnProperty.call(updates, "providerThinking")) {
      next.providerThinking = mergeNestedSettingMap(
        current.providerThinking,
        updates.providerThinking,
      );
    }
    if (Object.prototype.hasOwnProperty.call(updates, "comboStrategies")) {
      next.comboStrategies = mergeNestedSettingMap(
        current.comboStrategies,
        updates.comboStrategies,
      );
    }
    if (Object.prototype.hasOwnProperty.call(updates, "rtkFilterConfig")) {
      next.rtkFilterConfig = mergeNestedSettingMap(
        current.rtkFilterConfig,
        updates.rtkFilterConfig,
      );
    }
    if (Object.prototype.hasOwnProperty.call(updates, "dnsToolEnabled")) {
      next.dnsToolEnabled = mergeNestedSettingMap(
        current.dnsToolEnabled,
        updates.dnsToolEnabled,
      );
    }
    db.run(
      `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      [stringifyJson(next)]
    );
  });
  return mergeWithDefaults(next);
}

export async function isCloudEnabled() {
  const settings = await getSettings();
  return settings.cloudEnabled === true;
}

export async function getCloudUrl() {
  const settings = await getSettings();
  return (
    settings.cloudUrl ||
    process.env.CLOUD_URL ||
    process.env.NEXT_PUBLIC_CLOUD_URL ||
    ""
  );
}

export async function exportSettings() {
  return await readRaw();
}
