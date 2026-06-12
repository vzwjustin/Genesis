import { NextResponse } from "next/server";
import { killAppProcesses } from "@/lib/appUpdater";
import { requireSpawnRouteAuth } from "@/lib/auth/spawnRouteAuth";

// Shutdown app to release file locks for manual update
export async function POST(request) {
  const auth = await requireSpawnRouteAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    await killAppProcesses();
  } catch { /* best effort */ }

  const response = NextResponse.json({ success: true, message: "Shutting down for manual update..." });

  setTimeout(() => process.exit(0), 500);

  return response;
}
