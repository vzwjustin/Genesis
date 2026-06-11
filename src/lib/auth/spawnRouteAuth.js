import { verifyDashboardAuthToken } from "@/lib/auth/dashboardSession";
import { hasValidCliToken } from "@/shared/auth/cliToken";

/**
 * Auth for routes that spawn processes or read host secrets.
 * Accepts CLI token (local tooling) or a valid dashboard JWT — any Host,
 * so LAN dashboard users (e.g. 192.168.x.x:20128) are not forced onto localhost.
 */
export async function requireSpawnRouteAuth(request) {
  if (await hasValidCliToken(request)) return { ok: true };
  const token = request.cookies.get("auth_token")?.value;
  if (token && await verifyDashboardAuthToken(token)) return { ok: true };
  return { ok: false, error: "Login required", status: 401 };
}
