import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";

export async function GET() {
  try {
    const settings = await getSettings();
    const requireLogin = settings.requireLogin !== false;
    const tunnelDashboardAccess = settings.tunnelDashboardAccess === true;
    // tunnelUrl and tailscaleUrl are intentionally omitted — they are internal
    // hostnames that must not be exposed to unauthenticated callers.
    return NextResponse.json({ requireLogin, tunnelDashboardAccess });
  } catch (error) {
    return NextResponse.json({ requireLogin: true, tunnelDashboardAccess: false }, { status: 200 });
  }
}
