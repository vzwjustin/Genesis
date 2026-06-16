
import { NextResponse } from "next/server";
import { requireSpawnRouteAuth } from "@/lib/auth/spawnRouteAuth";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { getCliHomeDir } from "@/shared/utils/cliHome";

const execAsync = promisify(exec);

const getConfigDir = () => path.join(getCliHomeDir(), ".config", "opencode");
const getConfigPath = () => path.join(getConfigDir(), "opencode.json");

// Check if opencode CLI is installed (via which/where or config file exists)
const checkOpenCodeInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where opencode" : "which opencode";
    const env = isWindows
      ? { ...process.env, PATH: `${process.env.APPDATA}\\npm;${process.env.PATH}` }
      : process.env;
    await execAsync(command, { windowsHide: true, env });
    return true;
  } catch {
    try {
      await fs.access(getConfigPath());
      return true;
    } catch {
      return false;
    }
  }
};

const readConfig = async () => {
  try {
    const content = await fs.readFile(getConfigPath(), "utf-8");
    return JSON.parse(content);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};

const hasGenesisConfig = (config) => {
  if (!config?.provider) return false;
  return !!config.provider["genesis"];
};

function genesisProviderUsesClaudeWire(providerConfig) {
  const models = providerConfig?.models || {};
  const keys = Object.keys(models);
  return keys.length > 0 && keys.every((m) => typeof m === "string" && /^(cc\/|claude[-/])/i.test(m));
}

/** True when provider has any cc/claude model (may be mixed with cx/cu). */
function genesisProviderHasClaudeModels(providerConfig) {
  const models = providerConfig?.models || {};
  return Object.keys(models).some((m) => typeof m === "string" && /^(cc\/|claude[-/])/i.test(m));
}

function splitGenesisModelsByWire(models = {}) {
  const claude = {};
  const openai = {};
  for (const [id, meta] of Object.entries(models)) {
    if (typeof id === "string" && /^(cc\/|claude[-/])/i.test(id)) claude[id] = meta;
    else openai[id] = meta;
  }
  return { claude, openai };
}

function modelEntry(id) {
  return { name: id, modalities: { input: ["text", "image"], output: ["text"] } };
}

function providerPrefixForModel(id) {
  return /^(cc\/|claude[-/])/i.test(id) ? "genesis-cc" : "genesis";
}

function applyGenesisProviders(config, { modelsMap, normalizedBaseUrl, apiKey }) {
  if (!config.provider) config.provider = {};
  const { claude, openai } = splitGenesisModelsByWire(modelsMap);
  const keyToUse = apiKey || "sk_genesis";
  const hostBase = normalizedBaseUrl.replace(/\/v1\/?$/, "").replace(/\/$/, "");

  if (Object.keys(openai).length > 0) {
    config.provider.genesis = {
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: `${hostBase}/v1`, apiKey: keyToUse },
      models: openai,
    };
  } else {
    delete config.provider.genesis;
  }

  if (Object.keys(claude).length > 0) {
    config.provider["genesis-cc"] = {
      npm: "@ai-sdk/anthropic",
      options: { baseURL: hostBase, apiKey: keyToUse },
      models: claude,
    };
  } else {
    delete config.provider["genesis-cc"];
  }
}

function repairGenesisProviderSplit(config) {
  const merged = {
    ...(config.provider?.genesis?.models || {}),
    ...(config.provider?.["genesis-cc"]?.models || {}),
  };
  if (Object.keys(merged).length === 0) return config;
  const apiKey = config.provider?.genesis?.options?.apiKey
    || config.provider?.["genesis-cc"]?.options?.apiKey;
  const baseURL = config.provider?.genesis?.options?.baseURL
    || config.provider?.["genesis-cc"]?.options?.baseURL
    || "http://127.0.0.1:20128";
  const normalizedBaseUrl = String(baseURL).replace(/\/v1\/?$/, "").replace(/\/$/, "");
  applyGenesisProviders(config, { modelsMap: merged, normalizedBaseUrl, apiKey });

  if (typeof config.model === "string" && config.model.startsWith("genesis/")) {
    const id = config.model.replace(/^genesis\//, "");
    if (/^(cc\/|claude[-/])/i.test(id)) config.model = `genesis-cc/${id}`;
  }
  const explorerModel = config.agent?.explorer?.model;
  if (typeof explorerModel === "string" && explorerModel.startsWith("genesis/")) {
    const id = explorerModel.replace(/^genesis\//, "");
    if (/^(cc\/|claude[-/])/i.test(id)) {
      config.agent.explorer.model = `genesis-cc/${id}`;
    }
  }
  return config;
}

function diagnoseGenesisOpenCodeConfig(config) {
  const providerConfig = config?.provider?.["genesis"];
  if (!providerConfig) {
    return { hasGenesis: false, needsAnthropicWire: false, misconfigured: false };
  }
  const needsAnthropicWire = genesisProviderUsesClaudeWire(providerConfig);
  const hasClaudeModels = genesisProviderHasClaudeModels(providerConfig);
  const npm = providerConfig.npm || "";
  const baseURL = providerConfig.options?.baseURL || "";
  const misconfigured = hasClaudeModels && (
    (needsAnthropicWire && (npm !== "@ai-sdk/anthropic" || /\/v1\/?$/.test(String(baseURL).replace(/\/$/, ""))))
    || (!needsAnthropicWire && npm === "@ai-sdk/openai-compatible" && hasClaudeModels)
  );
  return {
    hasGenesis: true,
    needsAnthropicWire,
    hasClaudeModels,
    misconfigured,
    npm,
    baseURL,
    expectedNpm: needsAnthropicWire ? "@ai-sdk/anthropic" : "@ai-sdk/openai-compatible",
    expectedBaseURL: needsAnthropicWire
      ? String(baseURL).replace(/\/v1\/?$/, "").replace(/\/$/, "")
      : (baseURL.endsWith("/v1") ? baseURL : `${String(baseURL).replace(/\/$/, "")}/v1`),
    hint: !needsAnthropicWire && hasClaudeModels
      ? "Mixed cc/ + cx/cu models: use separate genesis-cc provider (@ai-sdk/anthropic, baseURL without /v1) for cc/claude models"
      : null,
  };
}

// GET - Check opencode CLI and read current settings
export async function GET(request) {
  const auth = await requireSpawnRouteAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    const isInstalled = await checkOpenCodeInstalled();

    if (!isInstalled) {
      return NextResponse.json({
        installed: false,
        config: null,
        message: "OpenCode CLI is not installed",
      });
    }

    const config = await readConfig();
    const providerConfig = config?.provider?.["genesis"];
    const modelMap = providerConfig?.models || {};
    const diagnostics = diagnoseGenesisOpenCodeConfig(config);

    return NextResponse.json({
      installed: true,
      config,
      hasGenesis: hasGenesisConfig(config),
      configPath: getConfigPath(),
      diagnostics,
        opencode: {
          models: Object.keys(modelMap),
          activeModel: config?.model?.startsWith("genesis/") ? config.model.replace(/^genesis\//, "") : null,
          baseURL: providerConfig?.options?.baseURL || null,
          npm: providerConfig?.npm || null,
        },
    });
  } catch (error) {
    console.log("Error checking opencode settings:", error);
    return NextResponse.json({ error: "Failed to check opencode settings" }, { status: 500 });
  }
}

// POST - Apply Genesis as openai-compatible provider (multi-model support)
export async function POST(request) {
  const auth = await requireSpawnRouteAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    const { baseUrl, apiKey, model, models, activeModel, subagentModel } = await request.json();

    // Accept either `model` (string, legacy) or `models` (array of strings)
    const modelsArray = Array.isArray(models) ? models.slice() : (typeof model === "string" ? [model] : []);

    if (!baseUrl || modelsArray.length === 0) {
      return NextResponse.json({ error: "baseUrl and at least one model are required" }, { status: 400 });
    }

    const configDir = getConfigDir();
    const configPath = getConfigPath();

    await fs.mkdir(configDir, { recursive: true });

    // Read existing config or start fresh
    let config = {};
    try {
      const existing = await fs.readFile(configPath, "utf-8");
      config = JSON.parse(existing);
    } catch { /* No existing config */ }

    const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
    const keyToUse = apiKey || "sk_genesis";
    const effectiveSubagentModel = subagentModel || modelsArray[0];

    // Ensure provider object
    if (!config.provider) config.provider = {};

    const existingModels = {
      ...(config.provider.genesis?.models || {}),
      ...(config.provider["genesis-cc"]?.models || {}),
    };
    for (const m of modelsArray) {
      if (!m || typeof m !== "string") continue;
      existingModels[m] = modelEntry(m);
    }
    applyGenesisProviders(config, {
      modelsMap: existingModels,
      normalizedBaseUrl,
      apiKey: keyToUse,
    });

    // Set the active model: prefer explicit activeModel, else first of modelsArray
    if (activeModel === "") {
      config.model = "";
    } else {
      const finalActive = activeModel || modelsArray[0];
      if (finalActive) {
        config.model = `${providerPrefixForModel(finalActive)}/${finalActive}`;
      }
    }

    // Add subagent configuration
    if (!config.agent) config.agent = {};
    config.agent.explorer = {
      description: "Fast explorer subagent for codebase exploration",
      mode: "subagent",
      model: `${providerPrefixForModel(effectiveSubagentModel)}/${effectiveSubagentModel}`,
    };

    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    return NextResponse.json({
      success: true,
      message: "OpenCode settings applied successfully!",
      configPath,
    });
  } catch (error) {
    console.log("Error applying opencode settings:", error);
    return NextResponse.json({ error: "Failed to apply settings" }, { status: 500 });
  }
}

// PATCH - Update specific settings (e.g., clear active model)
export async function PATCH(request) {
  const auth = await requireSpawnRouteAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    const { clearActiveModel, repairClaudeWire } = await request.json();
    const configPath = getConfigPath();

    let config = {};
    try {
      const existing = await fs.readFile(configPath, "utf-8");
      config = JSON.parse(existing);
    } catch (error) {
      if (error.code === "ENOENT") {
        return NextResponse.json({ success: true, message: "No config file found" });
      }
      throw error;
    }

    if (repairClaudeWire === true) {
      const before = diagnoseGenesisOpenCodeConfig(config);
      repairGenesisProviderSplit(config);
      await fs.writeFile(configPath, JSON.stringify(config, null, 2));
      const after = {
        ...diagnoseGenesisOpenCodeConfig(config),
        hasGenesisCc: !!config.provider?.["genesis-cc"],
      };
      return NextResponse.json({
        success: true,
        message: before.misconfigured || before.hint
          ? "Split genesis providers: genesis (openai wire) + genesis-cc (anthropic wire)"
          : "OpenCode genesis providers already configured",
        diagnostics: after,
      });
    }

    if (clearActiveModel === true) {
      // Clear active model but keep models in the list
      if (config.model?.startsWith("genesis/")) {
        config.model = "";
      }
    }

    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    return NextResponse.json({
      success: true,
      message: "Settings updated",
    });
  } catch (error) {
    console.log("Error patching opencode settings:", error);
    return NextResponse.json({ error: "Failed to patch settings" }, { status: 500 });
  }
}

// DELETE - Remove Genesis provider or specific models from config
export async function DELETE(request) {
  const auth = await requireSpawnRouteAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    const { searchParams } = new URL(request.url);
    const modelToRemove = searchParams.get("model");
    const configPath = getConfigPath();

    let config = {};
    try {
      const existing = await fs.readFile(configPath, "utf-8");
      config = JSON.parse(existing);
    } catch (error) {
      if (error.code === "ENOENT") {
        return NextResponse.json({ success: true, message: "No config file to reset" });
      }
      throw error;
    }

    // If specific model provided, remove just that model
    if (modelToRemove && config.provider?.["genesis"]?.models) {
      delete config.provider["genesis"].models[modelToRemove];
      
      // If no models left, remove the provider
      if (Object.keys(config.provider["genesis"].models).length === 0) {
        delete config.provider["genesis"];
        if (config.model?.startsWith("genesis/")) delete config.model;
      } else if (config.model === `genesis/${modelToRemove}`) {
        // If removed model was active, switch to first remaining model
        const remainingModels = Object.keys(config.provider["genesis"].models);
        config.model = `genesis/${remainingModels[0]}`;
      }
    } else {
      // No specific model - remove entire genesis provider
      if (config.provider) delete config.provider["genesis"];
      if (config.model?.startsWith("genesis/")) delete config.model;
    }

    // Remove subagent configuration
    if (config.agent?.explorer?.model?.startsWith("genesis/")) {
      delete config.agent.explorer;
      // Clean up empty agent object
      if (Object.keys(config.agent).length === 0) delete config.agent;
    }

    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    return NextResponse.json({
      success: true,
      message: modelToRemove ? `Model "${modelToRemove}" removed` : "Genesis settings removed from OpenCode",
    });
  } catch (error) {
    console.log("Error resetting opencode settings:", error);
    return NextResponse.json({ error: "Failed to reset opencode settings" }, { status: 500 });
  }
}
