import { NextResponse } from "next/server";
import { killAppProcesses, spawnUpdaterAndExit } from "@/lib/appUpdater";
import { formatUpdaterPackageSpec } from "@/shared/constants/config";
import { requireSpawnRouteAuth } from "@/lib/auth/spawnRouteAuth";

function normalizeTargetVersion(version) {
  if (typeof version !== "string") return "";
  const normalized = version.trim().replace(/^v/i, "");
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(normalized) ? normalized : null;
}

export async function POST(request) {
  const auth = await requireSpawnRouteAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (process.env.NODE_ENV !== "production") {
    return NextResponse.json(
      { success: false, message: "Update is only available in production build (9router CLI)" },
      { status: 403 }
    );
  }

  let body = {};
  try {
    body = request ? await request.json() : {};
  } catch {
    body = {};
  }
  const targetVersion = normalizeTargetVersion(body.version);
  if (targetVersion === null) {
    return NextResponse.json(
      { success: false, message: "Invalid 9Router version" },
      { status: 400 }
    );
  }
  const packageName = formatUpdaterPackageSpec(targetVersion);

  try {
    // Kill sibling processes (cloudflared, MITM, stray next-server) to release file locks on Windows
    await killAppProcesses();
  } catch { /* best effort */ }

  // Schedule detached updater then exit current server process
  spawnUpdaterAndExit(packageName);

  return NextResponse.json({ success: true, message: "Updater started. This app will exit shortly.", version: targetVersion || "latest" });
}
