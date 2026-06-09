/**
 * Extract lowercase hostname from an HTTP Host header (port and IPv6 brackets removed).
 * @param {string|null|undefined} hostHeader
 * @returns {string}
 */
export function normalizeHostHeaderHostname(hostHeader) {
  if (!hostHeader || typeof hostHeader !== "string") return "";

  const trimmed = hostHeader.trim().toLowerCase();
  if (!trimmed) return "";

  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    if (end <= 0) return "";
    return trimmed.slice(1, end);
  }

  // IPv4 host:port only — unbracketed IPv6 addresses contain multiple colons
  const colonCount = (trimmed.match(/:/g) || []).length;
  if (colonCount === 1) {
    const [host, port] = trimmed.split(":");
    if (/^\d+$/.test(port)) return host;
  }

  return trimmed;
}
