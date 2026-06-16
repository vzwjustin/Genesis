import { getModelsByProviderId } from "../config/providerModels.js";

/** Codex config.toml stores bare OpenAI Codex ids (gpt-5.5). Genesis maps them via cx/ aliases. */
export function isCodexNativeModelId(model) {
  return typeof model === "string" && model.length > 0 && !model.includes("/");
}

const NON_CHAT_CATALOG_TYPES = new Set(["image", "embedding", "tts", "stt"]);

let codexChatCatalogIds = null;

function loadCodexChatCatalogIds() {
  try {
    const models = getModelsByProviderId("codex");
    if (!Array.isArray(models)) return new Set();
    return new Set(
      models
        .filter((entry) => entry?.id && !NON_CHAT_CATALOG_TYPES.has(entry.type))
        .map((entry) => entry.id)
    );
  } catch {
    return new Set();
  }
}

function getCodexChatCatalogIds() {
  if (!codexChatCatalogIds) {
    codexChatCatalogIds = loadCodexChatCatalogIds();
  }
  return codexChatCatalogIds;
}

/** Test-only: reset module cache when providerModels is mocked per file. */
export function resetCodexChatCatalogCache() {
  codexChatCatalogIds = null;
}

/** Resolve bare Codex chat catalog ids (gpt-5.5) when Codex CLI sends native model names. */
export function resolveBareCodexModel(model) {
  if (!isCodexNativeModelId(model)) return null;
  if (!getCodexChatCatalogIds().has(model)) return null;
  return { provider: "codex", model };
}
