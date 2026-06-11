import { verifyDashboardAuthToken } from "@/lib/auth/dashboardSession";
import { hasValidLocalCliToken } from "@/shared/auth/cliToken";

/**
 * Auth for routes that spawn processes or read host secrets.
 * Accepts local CLI token (loopback/LAN socket) or a valid dashboard JWT.
 */
export async function requireSpawnRouteAuth(request) {
  if (await hasValidLocalCliToken(request)) return { ok: true };
  const token = request.cookies.get("auth_token")?.value;
  if (token && await verifyDashboardAuthToken(token)) return { ok: true };
  return { ok: false, error: "Login required", status: 401 };
}
