// Lazily initialized — dns is server-only (not available in webpack client bundles)
let resolve4, resolve6;
async function getDnsResolvers() {
  if (!resolve4) {
    const dns = await import("dns");
    const { promisify } = await import("util");
    resolve4 = promisify(dns.default?.resolve4 ?? dns.resolve4);
    resolve6 = promisify(dns.default?.resolve6 ?? dns.resolve6);
  }
  return { resolve4, resolve6 };
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
const DNS_RESOLVE_CACHE = new Map();
const DNS_RESOLVE_CACHE_TTL_MS = 60_000;

function isPrivateOrReservedIpv4(a, b) {
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 0) return true;
  return false;
}

function isIpv4Literal(host) {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) >= 0 && Number(p) <= 255);
}

function isPrivateOrReservedIpv6(host) {
  const lower = host.toLowerCase();
  if (lower === "::1" || lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) {
    return true;
  }
  if (lower.startsWith("::ffff:")) {
    const mapped = lower.slice(7);
    return isIpv4Literal(mapped) && isPrivateOrReservedIpv4(...mapped.split(".").map(Number));
  }
  return false;
}

export function isBlockedHostname(hostname) {
  if (!hostname) return true;
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (LOOPBACK_HOSTNAMES.has(h)) return true;
  if (h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h === "metadata.google.internal" || h === "metadata") return true;
  if (isIpv4Literal(h)) {
    const [a, b] = h.split(".").map(Number);
    return isPrivateOrReservedIpv4(a, b);
  }
  if (h.includes(":")) {
    return isPrivateOrReservedIpv6(h);
  }
  return false;
}

/**
 * Validate a URL is safe for server-side fetch (blocks private/metadata hosts).
 * @throws {Error} when URL is not allowed
 */
export function assertSafeFetchUrl(urlString, options = {}) {
  const { requireHttps = true, allowHttp = false, allowLoopback = false } = options;
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error("Invalid URL");
  }

  if (requireHttps && parsed.protocol !== "https:") {
    if (!(allowHttp && parsed.protocol === "http:")) {
      throw new Error("Only HTTPS URLs are allowed");
    }
  }

  if (parsed.username || parsed.password) {
    throw new Error("URLs with credentials are not allowed");
  }

  if (isBlockedHostname(parsed.hostname)) {
    const h = parsed.hostname.toLowerCase();
    if (!(allowLoopback && LOOPBACK_HOSTNAMES.has(h))) {
      throw new Error("URL host is not allowed");
    }
  }

  return parsed;
}

export function isSafeFetchUrl(urlString, options = {}) {
  try {
    assertSafeFetchUrl(urlString, options);
    return true;
  } catch {
    return false;
  }
}

/** Normalize and validate a provider base URL (no path traversal). */
export function validateProviderBaseUrl(baseUrl, options = {}) {
  const normalized = String(baseUrl || "").trim().replace(/\/$/, "");
  assertSafeFetchUrl(normalized, options);
  return normalized;
}

/**
 * Reject hostnames that resolve to private/reserved addresses (DNS rebinding guard).
 * @throws {Error} when resolution fails or any address is blocked
 */
export async function assertSafeResolvedHostname(hostname, options = {}) {
  const { allowLoopback = false } = options;
  const h = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) throw new Error("URL host is not allowed");

  if (allowLoopback && LOOPBACK_HOSTNAMES.has(h)) return;

  if (isIpv4Literal(h) || h.includes(":")) {
    if (isBlockedHostname(h)) throw new Error("URL host is not allowed");
    return;
  }

  const cached = DNS_RESOLVE_CACHE.get(h);
  let addresses;
  if (cached && Date.now() < cached.expiry) {
    addresses = cached.addresses;
  } else {
    const { resolve4: r4, resolve6: r6 } = await getDnsResolvers();
    addresses = [];
    try {
      addresses.push(...await r4(h));
    } catch (err) {
      if (err?.code !== "ENOTFOUND" && err?.code !== "ENODATA") throw err;
    }
    try {
      addresses.push(...await r6(h));
    } catch (err) {
      if (addresses.length === 0 && err?.code !== "ENOTFOUND" && err?.code !== "ENODATA") throw err;
    }

    if (addresses.length === 0) throw new Error("DNS resolution failed");
    DNS_RESOLVE_CACHE.set(h, { addresses, expiry: Date.now() + DNS_RESOLVE_CACHE_TTL_MS });
  }

  const safe = addresses.every((ip) => {
    if (allowLoopback && LOOPBACK_HOSTNAMES.has(ip.toLowerCase())) return true;
    return !isBlockedHostname(ip);
  });
  if (!safe) throw new Error("URL host resolves to a blocked address");
}

/** Validate URL hostname literals and resolved addresses. */
export async function assertSafeFetchUrlWithDns(urlString, options = {}) {
  const parsed = assertSafeFetchUrl(urlString, options);
  await assertSafeResolvedHostname(parsed.hostname, options);
  return parsed;
}

/** Normalize and validate a provider base URL including DNS resolution checks. */
export async function validateProviderBaseUrlWithDns(baseUrl, options = {}) {
  const normalized = String(baseUrl || "").trim().replace(/\/$/, "");
  await assertSafeFetchUrlWithDns(normalized, options);
  return normalized;
}
