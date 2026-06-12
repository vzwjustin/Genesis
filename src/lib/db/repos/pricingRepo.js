import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { makeKv } from "../helpers/kvStore.js";

const pricingKv = makeKv("pricing");
const CACHE_TTL_MS = 5000;

let cache = { value: null, expiresAt: 0 };

function invalidate() {
  cache = { value: null, expiresAt: 0 };
}

export async function getUserPricingOverrides() {
  return await pricingKv.getAll();
}

async function getUserPricing() {
  return await getUserPricingOverrides();
}

export async function getPricing() {
  const now = Date.now();
  if (cache.value && cache.expiresAt > now) return cache.value;

  const userPricing = await getUserPricing();
  const { buildDefaultPricingCatalog } = await import("@/shared/constants/pricing.js");
  const merged = buildDefaultPricingCatalog();

  for (const [provider, models] of Object.entries(userPricing)) {
    if (!merged[provider]) merged[provider] = {};
    for (const [model, pricing] of Object.entries(models)) {
      merged[provider][model] = merged[provider][model]
        ? { ...merged[provider][model], ...pricing }
        : { ...pricing };
    }
  }

  cache = { value: merged, expiresAt: now + CACHE_TTL_MS };
  return merged;
}

export async function getPricingForModel(provider, model) {
  if (!model) return null;
  const userPricing = await getUserPricing();
  const baseModel = model.includes("/") ? model.split("/").pop() : model;
  const { getProviderAlias, resolveProviderId } = await import("@/shared/constants/providers.js");

  const providerKeys = provider
    ? [...new Set([provider, getProviderAlias(provider), resolveProviderId(provider)])]
    : [];

  const { getPricingForModel: resolveConst } = await import("@/shared/constants/pricing.js");
  const defaults = resolveConst(provider, model);

  let userOverride = null;
  for (const key of providerKeys) {
    if (userPricing[key]?.[model]) {
      userOverride = userPricing[key][model];
      break;
    }
    if (userPricing[key]?.[baseModel]) {
      userOverride = userPricing[key][baseModel];
      break;
    }
  }
  if (!userOverride) {
    userOverride = userPricing.models?.[baseModel] || userPricing.models?.[model] || null;
  }

  if (!userOverride) return defaults;
  return defaults ? { ...defaults, ...userOverride } : { ...userOverride };
}

// Atomic merge inside transaction (per-provider read-modify-write)
export async function updatePricing(pricingData) {
  const db = await getAdapter();
  db.transaction(() => {
    for (const [provider, models] of Object.entries(pricingData)) {
      const row = db.get(`SELECT value FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
      const current = row ? (parseJson(row.value, {}) || {}) : {};
      const merged = { ...current };
      for (const [model, pricing] of Object.entries(models)) {
        if (pricing === null) {
          delete merged[model];
          continue;
        }
        if (!merged[model]) merged[model] = {};
        for (const [field, value] of Object.entries(pricing)) {
          if (value === null) {
            delete merged[model][field];
          } else {
            merged[model][field] = value;
          }
        }
        if (Object.keys(merged[model]).length === 0) {
          delete merged[model];
        }
      }
      if (Object.keys(merged).length === 0) {
        db.run(`DELETE FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
      } else {
        db.run(
          `INSERT INTO kv(scope, key, value) VALUES('pricing', ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
          [provider, stringifyJson(merged)]
        );
      }
    }
  });
  invalidate();
  return await getPricing();
}

export async function resetPricing(provider, model) {
  if (!provider) return await getUserPricing();
  const db = await getAdapter();
  db.transaction(() => {
    if (!model) {
      db.run(`DELETE FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
      return;
    }
    const row = db.get(`SELECT value FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
    const current = row ? (parseJson(row.value, {}) || {}) : {};
    delete current[model];
    if (Object.keys(current).length === 0) {
      db.run(`DELETE FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
    } else {
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES('pricing', ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [provider, stringifyJson(current)]
      );
    }
  });
  invalidate();
  return await getUserPricing();
}

export async function resetAllPricing() {
  await pricingKv.clear();
  invalidate();
  return {};
}
