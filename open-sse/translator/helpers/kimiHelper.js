/**
 * Kimi Coding API compatibility (K2.5/K2.6/K2.7 Code).
 *
 * Kimi rejects non-default sampling params, tool_choice other than auto/none,
 * disabled thinking on K2.7, and strict JSON Schema tool definitions.
 */

const KIMI_PROVIDERS = new Set(["kimi", "kimi-coding"]);

/** Models that require thinking enabled and fixed sampling defaults. */
const KIMI_CODE_MODEL_RE = /^kimi-k2\.(?:5|6|7)/i;

const KIMI_FIXED_PARAMS = {
  temperature: 1.0,
  top_p: 0.95,
  n: 1,
  presence_penalty: 0.0,
  frequency_penalty: 0.0,
};

const KIMI_STRIP_PARAMS = ["top_k", "seed", "stop"];

const SCHEMA_META_KEYS = new Set([
  "$schema", "$id", "$ref", "$defs", "definitions", "not", "anyOf", "oneOf", "allOf",
]);

export function isKimiProvider(provider) {
  return KIMI_PROVIDERS.has(provider);
}

export function isKimiCodeModel(model) {
  return KIMI_CODE_MODEL_RE.test(String(model || ""));
}

export function needsKimiCompatibility(provider, model) {
  return isKimiProvider(provider) && isKimiCodeModel(model);
}

/**
 * Kimi only accepts tool_choice auto/none. Claude Code may send any/tool/required.
 */
export function normalizeKimiToolChoice(toolChoice) {
  if (!toolChoice) return undefined;
  if (toolChoice === "none") return { type: "none" };
  if (toolChoice === "auto") return { type: "auto" };
  if (typeof toolChoice === "object") {
    if (toolChoice.type === "none") return { type: "none" };
    if (toolChoice.type === "auto") return { type: "auto" };
  }
  return { type: "auto" };
}

/**
 * Drop sampling params that differ from Kimi fixed values; strip unsupported fields.
 */
export function normalizeKimiSamplingParams(body) {
  for (const key of KIMI_STRIP_PARAMS) {
    delete body[key];
  }

  for (const [key, fixed] of Object.entries(KIMI_FIXED_PARAMS)) {
    if (body[key] === undefined) continue;
    const value = Number(body[key]);
    if (!Number.isFinite(value) || value !== fixed) {
      delete body[key];
    }
  }
}

/**
 * K2.7 Code errors when thinking is disabled.
 */
export function ensureKimiThinkingEnabled(body, model) {
  if (!isKimiCodeModel(model)) return;
  if (/k2\.7/i.test(model) && body.thinking?.type === "disabled") {
    body.thinking = { type: "enabled" };
    return;
  }
  if (/k2\.7/i.test(model) && !body.thinking) {
    body.thinking = { type: "enabled" };
  }
}

function normalizePropertySchema(prop) {
  if (!prop || typeof prop !== "object" || Array.isArray(prop)) {
    return { type: "string" };
  }
  const out = { ...prop };
  for (const key of SCHEMA_META_KEYS) {
    delete out[key];
  }
  if (!out.type) {
    if (Array.isArray(out.enum) && out.enum.length > 0) {
      out.type = typeof out.enum[0];
    } else {
      out.type = "string";
    }
  }
  if (out.type === "object") {
    return normalizeKimiInputSchema(out);
  }
  if (out.type === "array" && out.items && typeof out.items === "object") {
    out.items = normalizePropertySchema(out.items);
  }
  return out;
}

/**
 * Kimi strict JSON Schema: object schemas need properties + required; strip unsupported keys.
 */
export function normalizeKimiInputSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object", properties: {}, required: [] };
  }

  const out = { ...schema };
  for (const key of SCHEMA_META_KEYS) {
    delete out[key];
  }

  if (!out.type || out.type === "object") {
    out.type = "object";
    if (!out.properties || typeof out.properties !== "object" || Array.isArray(out.properties)) {
      out.properties = {};
    } else {
      const properties = {};
      for (const [name, prop] of Object.entries(out.properties)) {
        properties[name] = normalizePropertySchema(prop);
      }
      out.properties = properties;
    }
    if (!Array.isArray(out.required)) {
      out.required = [];
    }
  }

  return out;
}

export function normalizeKimiToolSchemas(tools) {
  if (!Array.isArray(tools)) return tools;
  return tools.map((tool) => {
    if (!tool || typeof tool !== "object") return tool;
    if (!tool.input_schema) return tool;
    const normalized = normalizeKimiInputSchema(tool.input_schema);
    if (normalized === tool.input_schema) return tool;
    return { ...tool, input_schema: normalized };
  });
}

/**
 * Apply all Kimi Coding compatibility fixes to a Claude-format request body.
 */
export function prepareKimiRequest(body, provider, model) {
  if (!needsKimiCompatibility(provider, model) || !body || typeof body !== "object") {
    return body;
  }

  delete body.output_config;
  normalizeKimiSamplingParams(body);
  ensureKimiThinkingEnabled(body, model);

  if (body.tool_choice !== undefined) {
    body.tool_choice = normalizeKimiToolChoice(body.tool_choice);
  }

  if (Array.isArray(body.tools)) {
    body.tools = normalizeKimiToolSchemas(body.tools);
  }

  return body;
}
