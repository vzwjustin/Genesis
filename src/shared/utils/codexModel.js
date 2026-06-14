/** Codex config.toml stores bare OpenAI Codex ids (gpt-5.5). Genesis maps them via cx/ aliases. */
export function isCodexNativeModelId(model) {
  return typeof model === "string" && model.length > 0 && !model.includes("/");
}

/** Strip cx/ or codex/ routing prefix only — other prefixes are invalid for Codex config. */
export function toCodexNativeModel(model) {
  if (!model || typeof model !== "string") return model;
  if (model.startsWith("cx/")) return model.slice(3);
  const slash = model.indexOf("/");
  if (slash > 0 && model.slice(0, slash) === "codex") return model.slice(slash + 1);
  return model;
}

/** For model picker highlight when config stores native ids. */
export function toCodexRoutingModel(nativeModel) {
  if (!nativeModel || typeof nativeModel !== "string") return nativeModel;
  if (nativeModel.includes("/")) return nativeModel;
  return `cx/${nativeModel}`;
}
