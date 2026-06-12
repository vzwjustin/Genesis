import { NextResponse } from "next/server";
import {
  getRequestLogSession,
  readRequestLogSessionFile,
} from "open-sse/utils/requestLogger.js";
import { requireSpawnRouteAuth } from "@/lib/auth/spawnRouteAuth";

export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  const auth = await requireSpawnRouteAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { name } = await params;
  const { searchParams } = new URL(request.url);
  const file = searchParams.get("file");

  if (file) {
    const data = await readRequestLogSessionFile(name, file);
    if (data.error) {
      return NextResponse.json(
        data,
        { status: data.error === "Session not found" || data.error === "File not found" ? 404 : 400 }
      );
    }
    return NextResponse.json(data);
  }

  const data = await getRequestLogSession(name);
  if (data.error) {
    return NextResponse.json(data, { status: data.error === "Session not found" ? 404 : 400 });
  }
  return NextResponse.json(data);
}
