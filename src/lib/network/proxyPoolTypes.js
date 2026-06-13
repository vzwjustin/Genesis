export const VALID_PROXY_TYPES = Object.freeze(["http", "vercel", "cloudflare", "deno"]);

export function normalizeProxyPoolType(value, { defaultType } = {}) {
  const type = typeof value === "string" ? value.trim() : "";

  if (
    (value === undefined || value === null || (typeof value === "string" && type === "")) &&
    defaultType !== undefined
  ) {
    return { type: defaultType };
  }

  if (VALID_PROXY_TYPES.includes(type)) {
    return { type };
  }

  return { error: "Invalid proxy pool type" };
}
