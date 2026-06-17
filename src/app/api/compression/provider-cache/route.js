import { NextResponse } from "next/server";
import { getProviderCacheStats } from "@/lib/usageDb";
import { getSearchCacheStats } from "open-sse/handlers/search/cache.js";
import { requireSpawnRouteAuth } from "@/lib/auth/spawnRouteAuth";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const auth = await requireSpawnRouteAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { searchParams } = new URL(request.url);
  const period = searchParams.get("period") || "7d";
  const provider = searchParams.get("provider") || undefined;

  const [providerCache, searchCache] = await Promise.all([
    getProviderCacheStats(period, { provider }),
    Promise.resolve(getSearchCacheStats()),
  ]);

  return NextResponse.json({
    period,
    providerCache,
    searchCache,
    updatedAt: new Date().toISOString(),
  });
}
