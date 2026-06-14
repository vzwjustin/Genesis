import { NextResponse } from "next/server";
import { requireSpawnRouteAuth } from "@/lib/auth/spawnRouteAuth";
import { latencyStore } from "../../../../../open-sse/utils/latencyMetrics.js";

/**
 * GET /api/metrics/latency
 * Returns per-provider per-model latency statistics (p50, p95, avg, count).
 * Requires authentication (same guard as /api/keys, /api/pricing).
 */
export async function GET(request) {
  const auth = await requireSpawnRouteAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  try {
    const stats = latencyStore.getStats();
    return NextResponse.json({ providers: stats });
  } catch {
    return NextResponse.json({ providers: {} });
  }
}
