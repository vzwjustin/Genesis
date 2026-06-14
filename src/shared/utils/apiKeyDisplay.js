/** Client-safe API key masking (no Node/crypto dependencies). */
export function maskApiKeyForDisplay(apiKey) {
  if (!apiKey || typeof apiKey !== "string") return "";
  if (apiKey === "sk_genesis") return "sk_9…";
  if (apiKey.length <= 16) return `${apiKey.slice(0, 4)}…`;
  return `${apiKey.slice(0, 12)}…${apiKey.slice(-4)}`;
}
