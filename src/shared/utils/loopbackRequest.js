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
  if (trimmed === "::1" || trimmed.startsWith("fe80:")) return true;
  return false;
}

function getSocketRemoteIp(request) {
  const socketIp = request.socket?.remoteAddress || request.ip;
  if (!socketIp) return null;
  return String(socketIp).replace(/^::ffff:/, "");
}

/**
 * True when the request appears to originate from the local machine (loopback host,
 * loopback origin, and no remote client IP in forwarding headers).
 */
export function isLoopbackRequest(request) {
  if (!isLoopbackHostname(request.headers.get("host"))) return false;

  const socketIp = getSocketRemoteIp(request);
  if (socketIp) {
    return isLoopbackIp(socketIp);
  }

  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const clientIp = xff.split(",")[0].trim();
    if (clientIp && !isLoopbackIp(clientIp)) return false;
  }
  const realIp = request.headers.get("x-real-ip");
  if (realIp && !isLoopbackIp(realIp.trim())) return false;

  // No socket info: require loopback Origin to block remote Host-header spoofing
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return isLoopbackHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}
