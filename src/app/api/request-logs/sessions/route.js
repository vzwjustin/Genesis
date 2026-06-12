import { NextResponse } from "next/server";
import { listRequestLogSessions } from "open-sse/utils/requestLogger.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
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
