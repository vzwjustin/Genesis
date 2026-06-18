import { NextResponse } from "next/server";
import { exportDb, getSettings, importDb } from "@/lib/localDb";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";
import { requireSpawnRouteAuth } from "@/lib/auth/spawnRouteAuth";
import {
  isDashboardPasswordConfigured,
  verifyDashboardPasswordForSensitiveAction,
} from "@/lib/auth/dashboardSession";
const PASSWORD_HEADER = "x-9r-password";

const PASSWORD_NOT_SET_ERROR =
  "Set a dashboard password in Profile before exporting or importing the database";

// Re-auth gate for sensitive DB export/import: a valid session or CLI token alone
// isn't enough — require the current password so a left-open dashboard can't exfil the DB.
async function requirePasswordReauth(password) {
  if (!(await isDashboardPasswordConfigured())) {
    return { ok: false, code: "password_not_set" };
  }
  const valid = await verifyDashboardPasswordForSensitiveAction(password);
  return { ok: valid, code: valid ? null : "invalid_password" };
}

function passwordReauthResponse(reauth) {
  if (reauth.ok) return null;
  if (reauth.code === "password_not_set") {
    return NextResponse.json({ error: PASSWORD_NOT_SET_ERROR }, { status: 403 });
  }
  return NextResponse.json({ error: "Invalid password" }, { status: 401 });
}

export async function GET(request) {
  const auth = await requireSpawnRouteAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const reauth = await requirePasswordReauth(request.headers.get(PASSWORD_HEADER));
  const reauthResponse = passwordReauthResponse(reauth);
  if (reauthResponse) return reauthResponse;
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
    const reauth = await requirePasswordReauth(password);
    const reauthResponse = passwordReauthResponse(reauth);
    if (reauthResponse) return reauthResponse;
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
