import { NextResponse } from "next/server";
import { getSettings, validateApiKey } from "@/lib/localDb";
import { verifyDashboardAuthToken } from "@/lib/auth/dashboardSession";
import { normalizeHostHeaderHostname } from "@/shared/utils/host";
import { isLoopbackRequest, isVerifiableLoopbackRequest } from "@/shared/utils/loopbackRequest.js";
import { hasValidCliToken } from "@/shared/auth/cliToken";
import {
  verifyApiKeyCrc,
  isLocalhostSentinelKey,
  has9routerCredentialAttempt,
  allowsStaleGatewayBypass,
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

// Routes that spawn child processes or read host secrets — restrict to localhost.
const LOCAL_ONLY_PATHS = [
  "/api/cli-tools/cowork-settings",
  "/api/cli-tools/antigravity-mitm",
  "/api/mcp/",
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
      if (isLoopbackRequest(request)) return true;
      continue;
    }
    if (!verifyApiKeyCrc(apiKey)) continue;
    if (await validateApiKey(apiKey)) return true;
  }
  return false;
}

async function getPublicLlmApiAuthError(request) {
  if (has9routerCredentialAttempt(request)) return "Invalid API key";
  if (isLoopbackRequest(request)) return "Missing API key";
  return "API key required for remote API access";
}

async function canAccessPublicLlmApi(request) {
  if (await hasValidCliToken(request)) return true;

  const settings = await loadSettings();
  const requireApiKey = settings?.requireApiKey === true;

  if (has9routerCredentialAttempt(request)) {
    if (await hasValidApiKey(request)) return true;
    if (!requireApiKey && isLoopbackRequest(request) && allowsStaleGatewayBypass(request)) {
      return true;
    }
    return false;
  }

  if (!requireApiKey && isLoopbackRequest(request)) return true;

  return false;
}

async function canAccessLocalOnlyRoute(request) {
  if (await hasValidCliToken(request)) return true;
  // Spawn-capable routes: verifiable loopback socket + valid JWT (Host alone is spoofable).
  if (isVerifiableLoopbackRequest(request) && await hasValidToken(request)) return true;
  return false;
}

async function hasValidToken(request) {
  const token = request.cookies.get("auth_token")?.value;
  return await verifyDashboardAuthToken(token);
}

// Read settings directly from DB to avoid self-fetch deadlock in proxy
async function loadSettings() {
  try {
    return await getSettings();
  } catch {
    return null;
  }
}

/** Dashboard UI / local-only routes: JWT or requireLogin disabled. */
async function isDashboardAccessAllowed(request) {
  if (await hasValidToken(request)) return true;
  const settings = await loadSettings();
  if (settings && settings.requireLogin === false) return true;
  return false;
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

  // Local-only gate for spawn-capable / host-secret routes.
  if (isLocalOnlyPath) {
    if (!(await canAccessLocalOnlyRoute(request))) {
      return NextResponse.json({ error: "Local only: CLI token required" }, { status: 403 });
    }
    // Local-only routes are fully authenticated above unless also always-protected.
    if (!ALWAYS_PROTECTED.some((p) => pathname.startsWith(p))) {
      return NextResponse.next();
    }
  }

  // Always protected - require valid JWT or local CLI token (machineId-based)
  if (ALWAYS_PROTECTED.some((p) => pathname.startsWith(p))) {
    if (await hasValidCliToken(request) || await hasValidToken(request))
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
    if (isPublicApi(pathname)) return NextResponse.next();
    if (await hasValidCliToken(request) || await isApiAuthenticated(request))
      return NextResponse.next();
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Protect all dashboard routes
  if (pathname.startsWith("/dashboard")) {
    let requireLogin = true;
    let tunnelDashboardAccess = false;

    try {
      const settings = await loadSettings();
      if (settings) {
        requireLogin = settings.requireLogin !== false;
        tunnelDashboardAccess = settings.tunnelDashboardAccess === true;

        // Block tunnel/tailscale access if disabled (redirect to login)
        if (!tunnelDashboardAccess) {
          const host = normalizeHostHeaderHostname(request.headers.get("host"));
          let tunnelHost = "";
          let tailscaleHost = "";
          try { tunnelHost = settings.tunnelUrl ? new URL(settings.tunnelUrl).hostname.toLowerCase() : ""; } catch {}
          try { tailscaleHost = settings.tailscaleUrl ? new URL(settings.tailscaleUrl).hostname.toLowerCase() : ""; } catch {}
          if ((tunnelHost && host === tunnelHost) || (tailscaleHost && host === tailscaleHost)) {
            return NextResponse.redirect(new URL("/login", request.url));
          }
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
