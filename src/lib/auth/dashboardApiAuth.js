import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession";
import { getSettings } from "@/lib/localDb";
import { isVerifiableLoopbackRequest } from "@/shared/utils/loopbackRequest.js";

/**
 * Dashboard API auth: session cookie or verifiable loopback when requireLogin=false.
 * Matches PATCH /api/settings behavior.
 */
export async function requireDashboardApiAuth(request) {
  const settings = await getSettings();
  const loopbackNoLogin = settings.requireLogin === false && isVerifiableLoopbackRequest(request);
  if (loopbackNoLogin) return { ok: true };

  const cookieStore = await cookies();
  const session = await getDashboardAuthSession(cookieStore.get("auth_token")?.value);
  if (!session) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  return { ok: true };
}

export function parseIsoDateParam(value, fieldName) {
  if (!value) return { ok: true, value: null };
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    return { ok: false, error: `Invalid ${fieldName}` };
  }
  return { ok: true, value: d.toISOString() };
}
