import { NextResponse } from "next/server";
import { requireSpawnRouteAuth } from "@/lib/auth/spawnRouteAuth";
import fs from "fs/promises";
import path from "path";
import { getCliHomeDir } from "@/shared/utils/cliHome";
import { getWireType } from "open-sse/config/wireType.js";

// Decision 1 (design.md): write generated Kiro provider blocks to an isolated
// file under Kiro's settings dir. Never touch Kiro-managed cli.json / mcp.json.
// Honor KIRO_HOME for the .kiro segment if set, else getCliHomeDir().
function getKiroHomeDir() {
  const kiroHome = process.env.KIRO_HOME?.trim();
  if (kiroHome) return kiroHome;
  return path.join(getCliHomeDir(), ".kiro");
}

const getKiroSettingsDir = () => path.join(getKiroHomeDir(), "settings");
const getKiroConfigPath = () => path.join(getKiroSettingsDir(), "genesis-providers.json");

const readConfig = async () => {
  try {
    const content = await fs.readFile(getKiroConfigPath(), "utf-8");
    return JSON.parse(content);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};

function isAnthropicWire(id) {
  return getWireType(id, { family: "broad" }) === "anthropic";
}

function splitModelsByWire(models = []) {
  const claude = {};
  const openai = {};
  for (const id of models) {
    if (typeof id !== "string" || !id) continue;
    if (isAnthropicWire(id)) claude[id] = {};
    else openai[id] = {};
  }
  return { claude, openai };
}

// POST body validation per Req 4.1/4.5. Returns array of offending field names.
function validatePostBody({ baseUrl, models, apiKey }) {
  const fields = [];
  if (typeof baseUrl !== "string" || baseUrl.length === 0) {
    fields.push("baseUrl");
  } else if (!/^https?:\/\//i.test(baseUrl) || /\/$/.test(baseUrl)) {
    // Must be HTTP/HTTPS with no trailing slash.
    fields.push("baseUrl");
  }
  const modelsValid = Array.isArray(models)
    && models.length > 0
    && models.every((m) => typeof m === "string" && m.length > 0);
  if (!modelsValid) fields.push("models");
  if (typeof apiKey !== "string" || apiKey.length === 0) fields.push("apiKey");
  return fields;
}

function buildProviderBlocks({ baseUrl, models, apiKey }) {
  const { claude, openai } = splitModelsByWire(models);
  const provider = {};
  if (Object.keys(openai).length > 0) {
    provider.genesis = {
      type: "openai",
      options: { baseURL: `${baseUrl}/v1`, apiKey },
      models: openai,
    };
  }
  if (Object.keys(claude).length > 0) {
    provider["genesis-cc"] = {
      type: "anthropic",
      options: { baseURL: baseUrl, apiKey },
      models: claude,
    };
  }
  return provider;
}

// GET - report whether the Kiro genesis config exists and its wire type (Req 4.6)
export async function GET(request) {
  const auth = await requireSpawnRouteAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    const config = await readConfig();
    const genesis = config?.provider?.genesis;
    const genesisCc = config?.provider?.["genesis-cc"];

    if (!genesis && !genesisCc) {
      return NextResponse.json({ exists: false });
    }

    let wireType;
    if (genesis && genesisCc) wireType = "mixed";
    else if (genesisCc) wireType = "anthropic";
    else wireType = "openai";

    return NextResponse.json({ exists: true, wireType, configPath: getKiroConfigPath() });
  } catch (error) {
    console.log("Error checking kiro settings:", error);
    return NextResponse.json({ error: "Failed to check kiro settings" }, { status: 500 });
  }
}

// POST - generate Kiro IDE provider config (Req 4.1-4.5)
export async function POST(request) {
  const auth = await requireSpawnRouteAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    const { baseUrl, apiKey, models } = await request.json();

    const invalidFields = validatePostBody({ baseUrl, models, apiKey });
    if (invalidFields.length > 0) {
      return NextResponse.json(
        { error: { message: "Invalid request fields", fields: invalidFields } },
        { status: 400 },
      );
    }

    const config = { provider: buildProviderBlocks({ baseUrl, models, apiKey }) };

    const configDir = getKiroSettingsDir();
    const configPath = getKiroConfigPath();
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    return NextResponse.json({
      success: true,
      message: "Kiro IDE settings applied successfully!",
      configPath,
    });
  } catch (error) {
    console.log("Error applying kiro settings:", error);
    return NextResponse.json({ error: "Failed to apply settings" }, { status: 500 });
  }
}
