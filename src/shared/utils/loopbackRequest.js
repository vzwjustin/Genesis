import { normalizeHostHeaderHostname } from "@/shared/utils/host";

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

function getSocketRemoteIp(request) {
  const socketIp = request.socket?.remoteAddress || request.ip;
  if (!socketIp) return null;
  return String(socketIp).replace(/^::ffff:/, "");
}

/** First client IP from common reverse-proxy / CDN forwarding headers. */
function getForwardedClientIp(request) {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const clientIp = xff.split(",")[0].trim();
    if (clientIp) return clientIp;
  }
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
