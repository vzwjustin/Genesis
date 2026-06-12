import { NextResponse } from "next/server";
import { listRequestLogSessions } from "open-sse/utils/requestLogger.js";
import { requireSpawnRouteAuth } from "@/lib/auth/spawnRouteAuth";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const auth = await requireSpawnRouteAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { searchParams } = new URL(request.url);
  const limit = Math.min(Number(searchParams.get("limit") || 50), 200);
  const data = await listRequestLogSessions(limit);
  return NextResponse.json(data);
}
