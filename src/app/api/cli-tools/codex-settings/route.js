
import { NextResponse } from "next/server";
import { requireSpawnRouteAuth } from "@/lib/auth/spawnRouteAuth";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { getCliHomeDir } from "@/shared/utils/cliHome";
import { parseTOML, stringifyTOML } from "confbox";
import { setModelAlias } from "@/models";
import { toCodexNativeModel } from "@/shared/utils/codexModel";

export { toCodexNativeModel };

const execAsync = promisify(exec);

/** Register alias so bare Codex model names resolve through genesis (gpt-5.5 → cx/gpt-5.5). */
async function ensureCodexModelAlias(nativeModel) {
  if (!nativeModel || typeof nativeModel !== "string" || nativeModel.includes("/")) return;
  await setModelAlias(nativeModel, `cx/${nativeModel}`);
}

const getCodexDir = () => path.join(getCliHomeDir(), ".codex");
const getCodexConfigPath = () => path.join(getCodexDir(), "config.toml");
const getCodexAuthPath = () => path.join(getCodexDir(), "auth.json");

// Flatten confbox-parsed TOML into a writable object, preserving nested tables
const parsedToWritable = (obj) => obj ?? {};

// Set a nested key from a flat dotted path, creating intermediate objects as needed
const setNestedSection = (obj, dottedKey, value) => {
  const keys = dottedKey.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur[keys[i]] == null || typeof cur[keys[i]] !== "object") {
      cur[keys[i]] = {};
    }
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
};

// Delete a nested key from a flat dotted path
const deleteNestedSection = (obj, dottedKey) => {
  const keys = dottedKey.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    cur = cur?.[keys[i]];
    if (cur == null) return;
  }
  delete cur[keys[keys.length - 1]];
};

// Check if codex CLI is installed (via which/where or config file exists)
const checkCodexInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where codex" : "which codex";
    const env = isWindows
      ? { ...process.env, PATH: `${process.env.APPDATA}\\npm;${process.env.PATH}` }
      : process.env;
    await execAsync(command, { windowsHide: true, env });
    return true;
  } catch {
    try {
      await fs.access(getCodexConfigPath());
      return true;
    } catch {
      return false;
    }
  }
};

// Read current config.toml
const readConfig = async () => {
  try {
    const configPath = getCodexConfigPath();
    const content = await fs.readFile(configPath, "utf-8");
    return content;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};

// Check if config has Genesis settings
const hasGenesisConfig = (config) => {
  if (!config) return false;
  return config.includes("model_provider = \"genesis\"") || config.includes("[model_providers.genesis]");
};

// GET - Check codex CLI and read current settings
export async function GET(request) {
  const auth = await requireSpawnRouteAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    const isInstalled = await checkCodexInstalled();
    
    if (!isInstalled) {
      return NextResponse.json({
        installed: false,
        config: null,
        message: "Codex CLI is not installed",
      });
    }

    const config = await readConfig();

    return NextResponse.json({
      installed: true,
      config,
      hasGenesis: hasGenesisConfig(config),
      configPath: getCodexConfigPath(),
    });
  } catch (error) {
    console.log("Error checking codex settings:", error);
    return NextResponse.json({ error: "Failed to check codex settings" }, { status: 500 });
  }
}

// POST - Update Genesis settings (merge with existing config)
export async function POST(request) {
  const auth = await requireSpawnRouteAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    const { baseUrl, apiKey, model, subagentModel } = await request.json();
    
    if (!baseUrl || !apiKey || !model) {
      return NextResponse.json({ error: "baseUrl, apiKey and model are required" }, { status: 400 });
    }

    const codexDir = getCodexDir();
    const configPath = getCodexConfigPath();

    // Ensure directory exists
    await fs.mkdir(codexDir, { recursive: true });

    // Read and parse existing config
    let parsed = {};
    try {
      const existingConfig = await fs.readFile(configPath, "utf-8");
      parsed = parsedToWritable(parseTOML(existingConfig));
    } catch { /* No existing config */ }

    const nativeModel = toCodexNativeModel(model);
    const nativeSubagentModel = toCodexNativeModel(subagentModel || model);

    // Update only Genesis related fields (api_key goes to auth.json, not config.toml)
    parsed.model = nativeModel;
    parsed.model_provider = "genesis";

    // Update or create genesis provider section (no api_key - Codex reads from auth.json)
    // Ensure /v1 suffix is added only once
    const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
    setNestedSection(parsed, "model_providers.genesis", {
      name: "Genesis",
      base_url: normalizedBaseUrl,
      wire_api: "responses",
    });

    // Add subagent configuration
    setNestedSection(parsed, "agents.subagent", {
      model: nativeSubagentModel,
    });

    // Write merged config
    const configContent = stringifyTOML(parsed);
    await fs.writeFile(configPath, configContent);

    await ensureCodexModelAlias(nativeModel);
    if (nativeSubagentModel !== nativeModel) {
      await ensureCodexModelAlias(nativeSubagentModel);
    }

    // Update auth.json with OPENAI_API_KEY (Codex reads this first)
    const authPath = getCodexAuthPath();
    let authData = {};
    try {
      const existingAuth = await fs.readFile(authPath, "utf-8");
      authData = JSON.parse(existingAuth);
    } catch { /* No existing auth */ }
    
    // Force apikey mode (keep existing tokens untouched for ChatGPT login reuse)
    authData.OPENAI_API_KEY = apiKey;
    authData.auth_mode = "apikey";
    await fs.writeFile(authPath, JSON.stringify(authData, null, 2));

    return NextResponse.json({
      success: true,
      message: "Codex settings applied successfully!",
      configPath,
    });
  } catch (error) {
    console.log("Error updating codex settings:", error);
    return NextResponse.json({ error: "Failed to update codex settings" }, { status: 500 });
  }
}

// DELETE - Remove Genesis settings only (keep other settings)
export async function DELETE(request) {
  const auth = await requireSpawnRouteAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    const configPath = getCodexConfigPath();

    // Read and parse existing config
    let parsed = {};
    try {
      const existingConfig = await fs.readFile(configPath, "utf-8");
      parsed = parsedToWritable(parseTOML(existingConfig));
    } catch (error) {
      if (error.code === "ENOENT") {
        return NextResponse.json({
          success: true,
          message: "No config file to reset",
        });
      }
      throw error;
    }

    // Remove Genesis related root fields only if they point to genesis
    if (parsed.model_provider === "genesis") {
      delete parsed.model;
      delete parsed.model_provider;
    }

    // Remove genesis provider section
    deleteNestedSection(parsed, "model_providers.genesis");

    // Remove subagent configuration
    deleteNestedSection(parsed, "agents.subagent");

    // Write updated config
    const configContent = stringifyTOML(parsed);
    await fs.writeFile(configPath, configContent);

    // Remove OPENAI_API_KEY from auth.json
    const authPath = getCodexAuthPath();
    try {
      const existingAuth = await fs.readFile(authPath, "utf-8");
      const authData = JSON.parse(existingAuth);
      delete authData.OPENAI_API_KEY;
      delete authData.auth_mode;

      // Write back or delete if empty
      if (Object.keys(authData).length === 0) {
        await fs.unlink(authPath);
      } else {
        await fs.writeFile(authPath, JSON.stringify(authData, null, 2));
      }
    } catch { /* No auth file */ }

    return NextResponse.json({
      success: true,
      message: "Genesis settings removed successfully",
    });
  } catch (error) {
    console.log("Error resetting codex settings:", error);
    return NextResponse.json({ error: "Failed to reset codex settings" }, { status: 500 });
  }
}
