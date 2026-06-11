import { MITM_TOOLS } from "@/shared/constants/cliTools";
import { getProviderAlias } from "@/shared/constants/providers";
import { getMitmAlias, setMitmAliasAll } from "@/models";
import { getApiKeys, getSettings, updateSettings } from "@/lib/localDb";
import { writeAliasForTool } from "@/lib/mitmAliasCache";
import {
  getMitmStatus,
  startServer,
  enableToolDNS,
  loadEncryptedPassword,
  getCachedPassword,
  hasDnsPrivilege,
  initDbHooks,
} from "@/mitm/manager";

/** OAuth provider id → MITM tool id (IDE traffic interception). */
const PROVIDER_TO_MITM_TOOL = {
  kiro: "kiro",
  cursor: "cursor",
  antigravity: "antigravity",
  github: "copilot",
};

/** Cross-provider defaults when the imported provider is not the IDE's native backend. */
const CROSS_MODEL_DEFAULTS = {
  kiro: {
    "claude-sonnet-4.6": "cc/claude-sonnet-4-6",
    "claude-sonnet-4.5": "cc/claude-sonnet-4-6",
    "claude-sonnet-4": "cc/claude-sonnet-4-6",
    "claude-haiku-4.5": "cc/claude-haiku-4-5-20251001",
    "deepseek-3.2": "deepseek/deepseek-chat",
    "MiniMax-M2.5": "minimax/MiniMax-M2.5",
    "qwen3-coder-next": "cc/claude-sonnet-4-6",
    "simple-task": "cc/claude-sonnet-4-6",
    "minimax-m2.1": "minimax/MiniMax-M2.5",
  },
  cursor: {
    "composer-2.5-fast": "cu/composer-2.5-fast",
    "composer-2.5": "cu/composer-2.5",
    "claude-opus-4-8-high": "cu/claude-opus-4-8-high",
    "claude-4.6-sonnet-medium": "cu/claude-4.6-sonnet-medium",
    "gpt-5.5-medium": "cu/gpt-5.5-medium",
    "auto": "cu/auto",
  },
};

let hooksInitialized = false;

function ensureMitmHooks() {
  if (hooksInitialized) return;
  initDbHooks(getSettings, updateSettings);
  hooksInitialized = true;
}

function buildDefaultMitmMappings(tool, importedProvider) {
  const toolConfig = MITM_TOOLS[tool];
  if (!toolConfig?.defaultModels?.length) return {};

  const providerAlias = getProviderAlias(importedProvider);
  const cross = CROSS_MODEL_DEFAULTS[tool] || {};
  const mappings = {};

  for (const model of toolConfig.defaultModels) {
    const key = model.alias || model.id;
    mappings[key] = cross[key] || `${providerAlias}/${model.id}`;
  }
  return mappings;
}

async function mergeMitmAliases(tool, importedProvider) {
  const existing = (await getMitmAlias(tool)) || {};
  const defaults = buildDefaultMitmMappings(tool, importedProvider);
  const merged = { ...defaults };
  for (const [key, value] of Object.entries(existing)) {
    if (value && String(value).trim()) merged[key] = value;
  }
  await setMitmAliasAll(tool, merged);
  writeAliasForTool(tool, merged);
  return merged;
}

async function resolveApiKey() {
  const keys = await getApiKeys();
  const active = keys.find((k) => k.isActive !== false);
  return active?.key || "sk_9router";
}

/**
 * After OAuth/token import, start MITM + DNS + default model mappings for IDE tools.
 * Fails open: returns status object; never throws to callers.
 */
export async function autoSetupMitmForProvider(provider, options = {}) {
  const tool = PROVIDER_TO_MITM_TOOL[provider];
  if (!tool) {
    return { attempted: false, skipped: true, reason: "no_mitm_tool" };
  }

  ensureMitmHooks();

  const settings = await getSettings();
  if (settings.mitmAutoSetupOnImport === false) {
    return { attempted: false, skipped: true, reason: "disabled_by_setting" };
  }

  const privileged = await hasDnsPrivilege();
  if (!privileged) {
    return {
      attempted: true,
      success: false,
      tool,
      reason: "needs_privilege",
      message: "MITM needs administrator or sudo access. Open MITM Proxy in the dashboard to finish setup.",
      dashboardUrl: "/dashboard/mitm",
    };
  }

  const result = {
    attempted: true,
    tool,
    serverStarted: false,
    dnsEnabled: false,
    aliasesSeeded: false,
  };

  try {
    const apiKey = options.apiKey || (await resolveApiKey());
    const sudoPassword =
      options.sudoPassword ||
      getCachedPassword() ||
      (await loadEncryptedPassword()) ||
      "";

    let status = await getMitmStatus();

    if (!status.running) {
      await startServer(apiKey, sudoPassword, false);
      result.serverStarted = true;
      status = await getMitmStatus();
    }

    if (!status.dnsStatus?.[tool]) {
      await enableToolDNS(tool, sudoPassword);
      result.dnsEnabled = true;
    }

    await mergeMitmAliases(tool, provider);
    result.aliasesSeeded = true;
    result.success = true;
    result.message = `MITM enabled for ${MITM_TOOLS[tool]?.name || tool}. Restart the IDE to apply.`;
    result.restartRequired = true;
    return result;
  } catch (error) {
    result.success = false;
    result.reason = "setup_failed";
    result.error = error.message || "MITM auto-setup failed";
    result.dashboardUrl = "/dashboard/mitm";
    return result;
  }
}
