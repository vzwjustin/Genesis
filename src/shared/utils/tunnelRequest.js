import { normalizeHostHeaderHostname } from "@/shared/utils/host";

function getRequestHostname(request) {
  if (process.env.TRUST_PROXY_HEADERS === "true") {
    const forwardedHost = request.headers?.get?.("x-forwarded-host");
    if (forwardedHost) {
      return normalizeHostHeaderHostname(forwardedHost.split(",")[0].trim());
    }
  }
  return normalizeHostHeaderHostname(request.headers.get("host"));
}

function normalizeConfiguredHostname(hostname) {
  if (!hostname || typeof hostname !== "string") return "";
  const h = hostname.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) return h.slice(1, -1);
  return h;
}

/**
 * @param {object|null|undefined} settings
 * @returns {{ tunnelHost: string, tailscaleHost: string }}
 */
export function getTunnelHostnames(settings) {
  let tunnelHost = "";
  let tailscaleHost = "";
  try {
    tunnelHost = normalizeConfiguredHostname(new URL(settings.tunnelUrl).hostname);
  } catch {}
  try {
    tailscaleHost = normalizeConfiguredHostname(new URL(settings.tailscaleUrl).hostname);
  } catch {}
  return { tunnelHost, tailscaleHost };
}

/**
 * True when the request Host matches configured tunnel or Tailscale dashboard URLs.
 * @param {import("next/server").NextRequest} request
 * @param {object|null|undefined} settings
 * @returns {boolean}
 */
export function isTunnelRequest(request, settings) {
  const host = getRequestHostname(request);
  const { tunnelHost, tailscaleHost } = getTunnelHostnames(settings);
  return (tunnelHost && host === tunnelHost) || (tailscaleHost && host === tailscaleHost);
}

/**
 * True when dashboard access should be denied for this tunnel/tailscale host.
 * @param {import("next/server").NextRequest} request
 * @param {object|null|undefined} settings
 * @returns {boolean}
 */
export function isTunnelDashboardAccessDenied(request, settings) {
  return isTunnelRequest(request, settings) && settings?.tunnelDashboardAccess !== true;
}
