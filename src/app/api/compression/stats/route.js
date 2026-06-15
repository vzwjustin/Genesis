import { NextResponse } from "next/server";
import { requireSpawnRouteAuth } from "@/lib/auth/spawnRouteAuth";
import { getCompressionStats } from "@/lib/compressionStats";
import { getHeadroomProxyStats } from "open-sse/rtk/headroom.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const auth = await requireSpawnRouteAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const [stats, headroomProxy] = await Promise.all([
    getCompressionStats(),
    getHeadroomProxyStats(),
  ]);
  return NextResponse.json({ ...stats, headroomProxy });
}
