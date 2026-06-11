import { normalizeHostHeaderHostname, isPrivateLanHostname, isPrivateLanIp } from "@/shared/utils/host";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function isLoopbackHostname(h) {
  return LOOPBACK_HOSTS.has(normalizeHostHeaderHostname(h));
}

function isLoopbackIp(ip) {
  if (!ip) return false;
  const trimmed = ip.trim();
  if (LOOPBACK_HOSTS.has(trimmed.toLowerCase())) return true;
  if (trimmed.startsWith("127.")) return true;
  if (trimmed === "::1") return true;
  return false;
}

export function getSocketRemoteIp(request) {
  const socketIp = request.socket?.remoteAddress || request.ip;
  if (!socketIp) return null;
  return String(socketIp).replace(/^::ffff:/, "");
}

/** RFC 7239 Forwarded: for=192.0.2.60 or for="[2001:db8::1]" */
function parseForwardedClientIp(forwarded) {
  if (!forwarded) return null;
  for (const part of forwarded.split(",")) {
    const match = part.trim().match(/^for=(?:\[([^\]]+)\]|"([^"]+)"|([^;\s]+))/i);
    if (!match) continue;
    const ip = (match[1] || match[2] || match[3]).trim();
    if (ip) return ip.replace(/^::ffff:/, "");
  }
  return null;
}

/** First client IP from common reverse-proxy / CDN forwarding headers. */
function getForwardedClientIp(request) {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const clientIp = xff.split(",")[0].trim();
    if (clientIp) return clientIp;
  }
  const forwarded = request.headers.get("forwarded");
  const forwardedIp = parseForwardedClientIp(forwarded);
  if (forwardedIp) return forwardedIp;
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  const cfConnecting = request.headers.get("cf-connecting-ip")?.trim();
  if (cfConnecting) return cfConnecting;
  const trueClient = request.headers.get("true-client-ip")?.trim();
  if (trueClient) return trueClient;
  return null;
}

/**
 * True when the request appears to originate from the local machine (loopback host,
 * loopback origin, and no remote client IP in forwarding headers).
 */
export function isLoopbackRequest(request) {
  if (!isLoopbackHostname(request.headers.get("host"))) return false;

  const forwardedIp = getForwardedClientIp(request);
  if (forwardedIp) {
    // Remote client IP in a forwarding header — never loopback (tunnel case).
    if (!isLoopbackIp(forwardedIp)) return false;
    // Loopback claimed in forwarding header — require loopback socket (local proxy).
    // Without socket info, fail closed: Origin is spoofable by non-browser clients.
    const socketIp = getSocketRemoteIp(request);
    if (socketIp) return isLoopbackIp(socketIp);
    return false;
  }

  const socketIp = getSocketRemoteIp(request);
  if (socketIp) {
    return isLoopbackIp(socketIp);
  }

  // Direct local connection: loopback Host, no forwarding headers (CLI clients omit Origin).
  return true;
}

/**
 * Stricter loopback check for management API / settings mutations.
 * Unlike isLoopbackRequest, never grants access from loopback Host alone when
 * socket IP is unavailable — Host is trivially spoofable by remote clients.
 */
/** Private LAN Host plus matching RFC1918 socket (Host alone is spoofable). */
export function isPrivateLanAccessRequest(request) {
  const host = normalizeHostHeaderHostname(request.headers.get("host"));
  if (!isPrivateLanHostname(host)) return false;
  const socketIp = getSocketRemoteIp(request);
  return socketIp ? isPrivateLanIp(socketIp) : false;
}

export function isVerifiableLoopbackRequest(request) {
  if (!isLoopbackHostname(request.headers.get("host"))) return false;

  const forwardedIp = getForwardedClientIp(request);
  if (forwardedIp) {
    if (!isLoopbackIp(forwardedIp)) return false;
    const socketIp = getSocketRemoteIp(request);
    return socketIp ? isLoopbackIp(socketIp) : false;
  }

  const socketIp = getSocketRemoteIp(request);
  if (!socketIp) return false;
  return isLoopbackIp(socketIp);
}
