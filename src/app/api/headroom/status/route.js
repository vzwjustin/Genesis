import { NextResponse } from "next/server";
import { requireSpawnRouteAuth } from "@/lib/auth/spawnRouteAuth";
import { getHeadroomStatus } from "open-sse/rtk/headroom.js";

export async function GET(request) {
  const auth = await requireSpawnRouteAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  try {
    const status = await getHeadroomStatus();
    return NextResponse.json(status);
  } catch (error) {
    return NextResponse.json({ installed: false, reachable: false, error: error.message }, { status: 500 });
  }
}
