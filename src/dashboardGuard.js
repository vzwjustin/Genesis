import { NextResponse } from "next/server";
import { getSettings, getSettingsSafe, validateApiKey } from "@/lib/localDb";
import { verifyDashboardAuthToken } from "@/lib/auth/dashboardSession";
import { normalizeHostHeaderHostname, isLanDashboardHost, isPrivateLanIp } from "@/shared/utils/host";
import {
  isLoopbackRequest,
  isVerifiableLoopbackRequest,
  isPrivateLanAccessRequest,
  isDashboardLoopbackSession,
  isLocalDashboardSession,
  getSocketRemoteIp,
} from "@/shared/utils/loopbackRequest.js";
import { isTunnelDashboardAccessDenied } from "@/shared/utils/tunnelRequest";
import { hasValidLocalCliToken } from "@/shared/auth/cliToken";
import {
  verifyApiKeyCrc,
  isLocalhostSentinelKey,
  hasgenesisCredentialAttempt,
  extractApiKey,
  getGatewayApiKeyCandidates,
} from "@/shared/utils/apiKey";

// Public API paths — no auth required (LLM API has its own key auth inside handler).
const PUBLIC_API_PATHS = [
  "/api/health",
  "/api/init",
  "/api/locale",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/status",
  "/api/auth/oidc",
  "/api/version",
  "/api/settings/require-login",
];

// Public top-level prefixes (LLM API endpoints gated here by API key or CLI token).
const PUBLIC_PREFIXES = ["/v1", "/v1beta", "/api/v1", "/api/v1beta", "/codex"];

// Always require JWT token regardless of requireLogin setting
const ALWAYS_PROTECTED = [
  "/api/shutdown",
  "/api/settings/database",
  "/api/version/shutdown",
  "/api/version/update",
  "/api/oauth/cursor/auto-import",
  "/api/oauth/kiro/auto-import",
];

// Routes that spawn processes, read host secrets, or mutate local CLI config.
const LOCAL_ONLY_PATHS = [
  "/api/cli-tools/",
  "/api/mcp/",
  "/api/tunnel/enable",
  "/api/tunnel/disable",
  "/api/tunnel/tailscale-enable",
  "/api/tunnel/tailscale-disable",
  "/api/tunnel/tailscale-install",
  "/api/tunnel/tailscale-check",
  "/api/oauth/cursor/auto-import",
  "/api/oauth/kiro/auto-import",
];

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

function isLocalRequest(request) {
  return isLoopbackRequest(request);
}

function isPublicLlmApi(pathname) {
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

async function hasValidApiKey(request) {
  for (const apiKey of getGatewayApiKeyCandidates(request)) {
    if (isLocalhostSentinelKey(apiKey)) {
      if (isVerifiableLoopbackRequest(request)) return true;
      continue;
    }
    if (!verifyApiKeyCrc(apiKey)) continue;
    if (await validateApiKey(apiKey)) return true;
  }
  return false;
}

async function getPublicLlmApiAuthError(request) {
  if (hasgenesisCredentialAttempt(request)) return "Invalid API key";
  if (isVerifiableLoopbackRequest(request)) return "Missing API key";
  return "API key required for remote API access";
}

async function canAccessPublicLlmApi(request) {
  if (await hasValidLocalCliToken(request)) return true;

  const settings = await loadSettings();
  const requireApiKey = settings?.requireApiKey === true;

  if (hasgenesisCredentialAttempt(request)) {
    if (await hasValidApiKey(request)) return true;
    return false;
  }

  if (!requireApiKey && isVerifiableLoopbackRequest(request)) return true;

  return false;
}

async function canAccessLocalOnlyRoute(request) {
  if (await hasValidLocalCliToken(request)) return true;
  if (!(await hasValidToken(request))) return false;
  if (isVerifiableLoopbackRequest(request)) return true;
  if (isPrivateLanAccessRequest(request)) return true;
  if (isDashboardLoopbackSession(request)) return true;
  if (isLocalDashboardSession(request)) return true;
  // Middleware often omits socket IP; browser fetch may omit Sec-Fetch-Site/Origin on GET.
  const hostHeader = request.headers.get("host");
  if (isLanDashboardHost(hostHeader)) {
    const origin = request.headers.get("origin");
    if (origin) {
      try {
        const originHost = normalizeHostHeaderHostname(new URL(origin).hostname);
        const requestHost = normalizeHostHeaderHostname(hostHeader);
        if (originHost !== requestHost) return false;
      } catch {
        return false;
      }
    }
    const socketIp = getSocketRemoteIp(request);
    if (socketIp && !isLoopbackIp(socketIp) && !isPrivateLanIp(socketIp)) {
      return false;
    }
    return true;
  }
  return false;
}

async function hasValidToken(request) {
  const token = request.cookies.get("auth_token")?.value;
  return await verifyDashboardAuthToken(token);
}

// Read settings directly from DB to avoid self-fetch deadlock in proxy.
// Fail CLOSED: getSettingsSafe() returns permissive defaults (requireApiKey:false)
// when the DB read throws — force strict auth gates instead.
async function loadSettings() {
  try {
    return await getSettings();
  } catch {
    return { ...(await getSettingsSafe()), requireApiKey: true, requireLogin: true };
  }
}

const TUNNEL_DASHBOARD_DISABLED_ERROR = "Dashboard access via tunnel is disabled";

/** Block JWT dashboard API on tunnel/tailscale when exposure is disabled; local CLI token still OK. */
async function rejectTunnelDashboardApi(request, settings) {
  if (!isTunnelDashboardAccessDenied(request, settings)) return null;
  if (await hasValidLocalCliToken(request)) return null;
  return NextResponse.json({ error: TUNNEL_DASHBOARD_DISABLED_ERROR }, { status: 403 });
}

/** Block password/OIDC login on tunnel when exposure is disabled (no CLI bypass). */
function rejectTunnelDashboardAuth(request, settings) {
  if (!isTunnelDashboardAccessDenied(request, settings)) return null;
  if (
    request.method === "GET"
    && request.nextUrl.pathname.startsWith("/api/auth/oidc")
  ) {
    return NextResponse.redirect(new URL("/login?error=tunnel_dashboard_disabled", request.url));
  }
  return NextResponse.json({ error: TUNNEL_DASHBOARD_DISABLED_ERROR }, { status: 403 });
}

/** Management API routes: JWT, CLI token, or verifiable loopback when requireLogin=false. */
async function isApiAuthenticated(request) {
  if (await hasValidToken(request)) return true;
  const settings = await loadSettings();
  if (settings && settings.requireLogin === false && isVerifiableLoopbackRequest(request)) return true;
  return false;
}

function isPublicApi(pathname) {
  if (isPublicLlmApi(pathname)) return true;
  return PUBLIC_API_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export const __test__ = {
  isLocalRequest,
  isPublicLlmApi,
  extractApiKey,
  canAccessPublicLlmApi,
  canAccessLocalOnlyRoute,
};

export async function proxy(request) {
  const { pathname } = request.nextUrl;

  const isLocalOnlyPath = LOCAL_ONLY_PATHS.some((p) => pathname.startsWith(p));
  const settings = isLocalOnlyPath || ALWAYS_PROTECTED.some((p) => pathname.startsWith(p))
    ? await loadSettings()
    : null;

  // Local-only gate for spawn-capable / host-secret routes.
  if (isLocalOnlyPath) {
    const tunnelBlocked = await rejectTunnelDashboardApi(request, settings);
    if (tunnelBlocked) return tunnelBlocked;
    if (!(await canAccessLocalOnlyRoute(request))) {
      return NextResponse.json({ error: "CLI token or login required" }, { status: 403 });
    }
    // Local-only routes are fully authenticated above unless also always-protected.
    if (!ALWAYS_PROTECTED.some((p) => pathname.startsWith(p))) {
      return NextResponse.next();
    }
  }

  // Always protected - require valid JWT or local CLI token (machineId-based)
  if (ALWAYS_PROTECTED.some((p) => pathname.startsWith(p))) {
    const tunnelBlocked = await rejectTunnelDashboardApi(request, settings);
    if (tunnelBlocked) return tunnelBlocked;
    if (await hasValidLocalCliToken(request) || await hasValidToken(request))
      return NextResponse.next();
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (isPublicLlmApi(pathname)) {
    if (await canAccessPublicLlmApi(request)) return NextResponse.next();
    const error = await getPublicLlmApiAuthError(request);
    return NextResponse.json({ error }, { status: 401 });
  }

  // Deny-by-default for /api/* — public allow-list bypasses, everything else requires auth.
  if (pathname.startsWith("/api/")) {
    if (isPublicApi(pathname)) {
      const settings = await loadSettings();
      if (pathname === "/api/auth/login" || pathname.startsWith("/api/auth/oidc")) {
        const authBlocked = rejectTunnelDashboardAuth(request, settings);
        if (authBlocked) return authBlocked;
      }
      if (isTunnelDashboardAccessDenied(request, settings)) {
        if (pathname === "/api/auth/status") {
          return NextResponse.json({
            requireLogin: true,
            authMode: "password",
            oidcConfigured: false,
            oidcLoginLabel: "Sign in with OIDC",
            hasPassword: false,
            displayName: "Password user",
            loginMethod: "Password",
            oidcName: null,
            oidcEmail: null,
            oidcLogin: false,
          });
        }
        if (pathname === "/api/settings/require-login") {
          return NextResponse.json({ requireLogin: true, tunnelDashboardAccess: false });
        }
      }
      return NextResponse.next();
    }
    const tunnelBlocked = await rejectTunnelDashboardApi(request, await loadSettings());
    if (tunnelBlocked) return tunnelBlocked;
    if (await hasValidLocalCliToken(request) || await isApiAuthenticated(request))
      return NextResponse.next();
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Protect all dashboard routes
  if (pathname.startsWith("/dashboard")) {
    let requireLogin = true;

    try {
      const settings = await loadSettings();
      if (settings) {
        requireLogin = settings.requireLogin !== false;
        if (isTunnelDashboardAccessDenied(request, settings)) {
          return NextResponse.redirect(new URL("/login", request.url));
        }
      }
    } catch {
      // On error, keep defaults (require login, block tunnel)
    }

    // If login not required, allow through
    if (!requireLogin) return NextResponse.next();

    // Verify JWT token
    const token = request.cookies.get("auth_token")?.value;
    if (token) {
      if (await verifyDashboardAuthToken(token)) {
        return NextResponse.next();
      } else {
        return NextResponse.redirect(new URL("/login", request.url));
      }
    }

    return NextResponse.redirect(new URL("/login", request.url));
  }

  // Redirect / to /dashboard if logged in, or /dashboard if it's the root
  if (pathname === "/") {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return NextResponse.next();
}
