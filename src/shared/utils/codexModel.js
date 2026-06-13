/** Codex config.toml uses native OpenAI model ids (gpt-5.5), not 9router routing ids (cx/gpt-5.5). */
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
