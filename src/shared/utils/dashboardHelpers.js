const PRICING_FIELDS = ["input", "output", "cached", "reasoning", "cache_creation"];

/**
 * Build PUT bodies to swap priority values between two connections.
 * Swaps stored priority numbers, not array indices.
 */
export function swapConnectionPriorityUpdates(conn1, conn2) {
  const priority1 = conn1.priority ?? 999;
  const priority2 = conn2.priority ?? 999;
  return [
    { connectionId: conn1.id, priority: priority2 },
    { connectionId: conn2.id, priority: priority1 },
  ];
}

/**
 * Pick the active connection with the highest priority (lowest priority number).
 */
export function pickHighestPriorityActiveConnection(connections) {
  const active = (connections || []).filter((conn) => conn.isActive !== false);
  if (active.length === 0) return null;
  return [...active].sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))[0];
}

/**
 * Return pricing PATCH payload: changed fields plus null tombstones for cleared overrides.
 * @param {object} existingOverrides - raw user overrides from DB (not merged with defaults)
 */
export function diffPricingOverrides(current, defaults, existingOverrides = {}) {
  const overrides = {};

  for (const provider of Object.keys(current || {})) {
    for (const model of Object.keys(current[provider] || {})) {
      const currentPricing = current[provider][model] || {};
      const defaultPricing = defaults?.[provider]?.[model] || {};
      const changedFields = {};

      const existingModelOverrides = existingOverrides?.[provider]?.[model] || {};
      const tombstoneFields = {};

      for (const field of PRICING_FIELDS) {
        const currentValue = currentPricing[field];
        const defaultValue = defaultPricing[field];
        if (currentValue !== defaultValue) {
          changedFields[field] = currentValue;
        } else if (Object.prototype.hasOwnProperty.call(existingModelOverrides, field)) {
          tombstoneFields[field] = null;
        }
      }

      const patch = { ...changedFields, ...tombstoneFields };
      if (Object.keys(patch).length > 0) {
        const allMatchDefault = PRICING_FIELDS.every(
          (field) => currentPricing[field] === defaultPricing[field],
        );
        if (!overrides[provider]) overrides[provider] = {};
        overrides[provider][model] = allMatchDefault && existingOverrides?.[provider]?.[model]
          ? null
          : patch;
      }
    }
  }

  for (const [provider, models] of Object.entries(existingOverrides || {})) {
    for (const model of Object.keys(models || {})) {
      if (overrides[provider]?.[model] !== undefined) continue;
      const currentPricing = current?.[provider]?.[model] || {};
      const defaultPricing = defaults?.[provider]?.[model] || {};
      const matchesDefault = PRICING_FIELDS.every(
        (field) => currentPricing[field] === defaultPricing[field],
      );
      if (matchesDefault) {
        if (!overrides[provider]) overrides[provider] = {};
        overrides[provider][model] = null;
      }
    }
  }

  return overrides;
}

export function isAbortError(error) {
  return error?.name === "AbortError";
}

const IMPORT_AUTH_WARNING_RE = /session expired|re-?auth|reconnect|401|403|invalid token|expired token|token expired|missing token|no models returned/i;

export function isImportModelsAuthFailure(data) {
  if (!data || typeof data !== "object") return false;
  if (data.authFailure) return true;
  if (typeof data.warning === "string" && IMPORT_AUTH_WARNING_RE.test(data.warning)) return true;
  return false;
}

/**
 * Parse one proxy import line (URL or host:port:user:pass, including IPv6 brackets).
 * @returns {{ proxyUrl: string, name: string } | null}
 */
export function parseProxyLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;

  if (trimmed.includes("://")) {
    const parsed = new URL(trimmed);
    const hostLabel = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
    return {
      proxyUrl: parsed.toString(),
      name: `Imported ${hostLabel}`,
    };
  }

  const ipv6Match = trimmed.match(/^\[([^\]]+)\]:(\d+):([^:]+):(.+)$/);
  if (ipv6Match) {
    const [, host, port, username, password] = ipv6Match;
    if (!host || !port || !username || !password) {
      throw new Error("Invalid [host]:port:user:pass format");
    }
    const proxyUrl = `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@[${host}]:${port}`;
    return {
      proxyUrl,
      name: `Imported [${host}]:${port}`,
    };
  }

  const parts = trimmed.split(":");
  if (parts.length === 4) {
    const [host, port, username, password] = parts;
    if (!host || !port || !username || !password) {
      throw new Error("Invalid host:port:user:pass format");
    }

    const proxyUrl = `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
    return {
      proxyUrl,
      name: `Imported ${host}:${port}`,
    };
  }

  throw new Error("Unsupported format");
}

/**
 * Build comboStrategies PATCH payload when a combo is renamed.
 */
export function buildComboStrategyRenamePatch(oldName, newName, comboStrategies = {}) {
  if (!oldName || !newName || oldName === newName) return null;
  const strategy = comboStrategies[oldName];
  if (!strategy) return { [oldName]: null };
  return {
    [oldName]: null,
    [newName]: strategy,
  };
}

/**
 * Build comboStrategies PATCH payload when a combo is deleted.
 */
export function buildComboStrategyDeletePatch(comboName) {
  if (!comboName) return null;
  return { [comboName]: null };
}
