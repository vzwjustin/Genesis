import { NextResponse } from "next/server";
import { resetCompressionStats } from "@/lib/compressionStats";
import { requireSpawnRouteAuth } from "@/lib/auth/spawnRouteAuth";

export async function POST(request) {
  const auth = await requireSpawnRouteAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const stats = await resetCompressionStats();
  return NextResponse.json({ success: true, stats });
}
