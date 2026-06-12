import { NextResponse } from "next/server";
import { listRequestLogSessions } from "open-sse/utils/requestLogger.js";
import { requireSpawnRouteAuth } from "@/lib/auth/spawnRouteAuth";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const auth = await requireSpawnRouteAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { searchParams } = new URL(request.url);
  const rawLimit = searchParams.get("limit");
  const parsedLimit = rawLimit == null || rawLimit === "" ? 50 : Number(rawLimit);
  if (!Number.isFinite(parsedLimit) || parsedLimit < 1) {
    return NextResponse.json(
      { error: "Invalid limit: must be a positive number" },
      { status: 400 },
    );
  }
  const limit = Math.min(Math.floor(parsedLimit), 200);
  const data = await listRequestLogSessions(limit);
  return NextResponse.json(data);
}
