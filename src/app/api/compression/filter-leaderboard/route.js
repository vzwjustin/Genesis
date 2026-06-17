import { NextResponse } from "next/server";
import { getFilterLeaderboard } from "@/lib/compressionStats";
import { requireSpawnRouteAuth } from "@/lib/auth/spawnRouteAuth";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const auth = await requireSpawnRouteAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { searchParams } = new URL(request.url);
  const limit = Math.min(Number(searchParams.get("limit") || 20), 100);
  const since = searchParams.get("since") || undefined;
  const rows = await getFilterLeaderboard({ limit, since });
  return NextResponse.json({ rows, updatedAt: new Date().toISOString() });
}
