import { NextResponse } from "next/server";
import { getProviderCompressionStats } from "@/lib/compressionStats";
import { requireSpawnRouteAuth } from "@/lib/auth/spawnRouteAuth";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const auth = await requireSpawnRouteAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { searchParams } = new URL(request.url);
  const period = searchParams.get("period") || "7d";
  const provider = searchParams.get("provider") || undefined;

  const stats = await getProviderCompressionStats(period, { provider });

  return NextResponse.json({
    ...stats,
    updatedAt: new Date().toISOString(),
  });
}
