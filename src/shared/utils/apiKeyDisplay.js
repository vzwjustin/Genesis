/** Client-safe API key masking (no Node/crypto dependencies). */
export function maskApiKeyForDisplay(apiKey) {
  if (!apiKey || typeof apiKey !== "string") return "";
  if (apiKey === "sk_genesis") return "sk_9…";
  if (apiKey.length <= 10) return apiKey;
  return apiKey.slice(0, 6) + "•".repeat(apiKey.length - 10) + apiKey.slice(-4);
}
