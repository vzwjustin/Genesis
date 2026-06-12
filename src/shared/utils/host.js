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

/**
 * True when hostname is a private RFC1918 IPv4 address (not loopback).
 * Used to allow dashboard JWT on LAN without treating public/tunnel hosts as local.
 * @param {string|null|undefined} hostname
 * @returns {boolean}
 */
function isPrivateLanIPv4(value) {
  if (!value || typeof value !== "string") return false;
  const h = value.trim().toLowerCase().replace(/^::ffff:/, "");
  if (!h || h === "localhost" || h === "::1" || h.startsWith("127.")) return false;
  if (h.startsWith("10.")) return true;
  if (h.startsWith("192.168.")) return true;
  const m = h.match(/^172\.(\d+)\./);
  if (m) {
    const second = Number(m[1]);
    return second >= 16 && second <= 31;
  }
  return false;
}

export function isPrivateLanHostname(hostname) {
  return isPrivateLanIPv4(hostname);
}

/** True when the socket/client IP is in a private RFC1918 range. */
export function isPrivateLanIp(ip) {
  return isPrivateLanIPv4(ip);
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function isLoopbackHost(hostname) {
  const h = normalizeHostHeaderHostname(hostname);
  return LOOPBACK_HOSTS.has(h) || h.startsWith("127.");
}

/**
 * Host header looks like a local/LAN dashboard (IP, loopback, or machine name like dietpi).
 * Excludes public DNS names used for tunnels (e.g. router.example.com).
 */
export function isLanDashboardHost(hostHeader) {
  const host = normalizeHostHeaderHostname(hostHeader);
  if (!host) return false;
  if (isLoopbackHost(host)) return true;
  if (isPrivateLanIPv4(host)) return true;
  if (!host.includes(".")) return true;
  if (host.endsWith(".local") || host.endsWith(".lan")) return true;
  return false;
}
