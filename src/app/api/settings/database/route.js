import { NextResponse } from "next/server";
import { exportDb, getSettings, importDb } from "@/lib/localDb";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";
import { requireSpawnRouteAuth } from "@/lib/auth/spawnRouteAuth";
import { verifyDashboardPassword } from "@/lib/auth/dashboardSession";
const PASSWORD_HEADER = "x-9r-password";

// Re-auth gate for sensitive DB export/import: a valid session or CLI token alone
// isn't enough — require the current password so a left-open dashboard can't exfil the DB.
async function requirePasswordReauth(_request, password) {
  return verifyDashboardPassword(password);
}

export async function GET(request) {
  const auth = await requireSpawnRouteAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (!(await requirePasswordReauth(request, request.headers.get(PASSWORD_HEADER)))) {
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }
  try {
    const payload = await exportDb();
    return NextResponse.json(payload);
  } catch (error) {
    console.log("Error exporting database:", error);
    return NextResponse.json({ error: "Failed to export database" }, { status: 500 });
  }
}

export async function POST(request) {
  const auth = await requireSpawnRouteAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    const { password, ...payload } = await request.json();
    if (!(await requirePasswordReauth(request, password))) {
      return NextResponse.json({ error: "Invalid password" }, { status: 401 });
    }
    await importDb(payload);

    // Ensure proxy settings take effect immediately after a DB import.
    try {
      const settings = await getSettings();
      applyOutboundProxyEnv(settings);
    } catch (err) {
      console.warn("[Settings][DatabaseImport] Failed to re-apply outbound proxy env:", err);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error importing database:", error);
    return NextResponse.json(
      { error: error?.message || "Failed to import database" },
      { status: 400 }
    );
  }
}
