// Sync SSRF URL-validation primitives. NO node: imports — this module is safe to
// pull into the webpack client bundle (providers.js → ModelSelectModal imports it).
// DNS-resolution guards (which need node:dns) live in ssrfGuard.js.

export const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

function isPrivateOrReservedIpv4(a, b) {
  if (a === 10) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // RFC 6598 CGNAT
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

// Expand an IPv6 literal to its 8 hextets (numbers). Returns null if not a
// well-formed IPv6 literal. Handles `::` compression and a trailing dotted-quad
// (e.g. ::ffff:127.0.0.1). This lets us classify EVERY form that embeds an IPv4
// address rather than denylisting individual textual encodings.
function expandIpv6(host) {
  let h = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, ""); // strip brackets + zone id
  // Trailing dotted-quad → two hextets
  const dotted = h.match(/(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) {
    const o = dotted[2].split(".").map(Number);
    if (o.some((n) => n > 255)) return null;
    h = dotted[1] + ((o[0] << 8) | o[1]).toString(16) + ":" + ((o[2] << 8) | o[3]).toString(16);
  }
  const parts = h.split("::");
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
  let groups;
  if (parts.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...Array(fill).fill("0"), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const out = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out;
}

// Is hextet pair (hx[i], hx[j]) an embedded private/reserved IPv4 address?
function embeddedV4Private(hx, i, j) {
  return isPrivateOrReservedIpv4(hx[i] >> 8, hx[i] & 0xff, hx[j] >> 8, hx[j] & 0xff);
}

function isPrivateOrReservedIpv6(host) {
  const lower = host.toLowerCase();
  if (lower === "::1" || lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) {
    return true;
  }
  const hx = expandIpv6(lower);
  if (!hx) return false;
  if (hx.every((x) => x === 0)) return true; // :: unspecified — connects to loopback/0.0.0.0 on most stacks
  // NAT64 (RFC 6052 well-known 64:ff9b::/96 and RFC 8215 local-use 64:ff9b:1::/48)
  if (hx[0] === 0x64 && hx[1] === 0xff9b) return embeddedV4Private(hx, 6, 7);
  // 6to4 (RFC 3056 2002::/16) — embeds the v4 address in hextets 1-2
  if (hx[0] === 0x2002) return embeddedV4Private(hx, 1, 2);
  // IPv4-mapped (::ffff:0:0/96) and deprecated IPv4-compatible (::/96) — embed v4 in the last two hextets
  if (hx[0] === 0 && hx[1] === 0 && hx[2] === 0 && hx[3] === 0 && hx[4] === 0 && (hx[5] === 0 || hx[5] === 0xffff)) {
    if (hx[6] === 0 && hx[7] === 0) return false; // pure :: handled above
    return embeddedV4Private(hx, 6, 7);
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
