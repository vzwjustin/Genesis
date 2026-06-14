import { NextResponse } from "next/server";
import { swapProviderConnectionPriorities } from "@/models";
import { requireSpawnRouteAuth } from "@/lib/auth/spawnRouteAuth";

export const dynamic = "force-dynamic";

/** POST /api/providers/swap-priority — atomically swap two connection priorities */
export async function POST(request) {
  const auth = await requireSpawnRouteAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    const body = await request.json();
    const connectionId1 = body?.connectionId1;
    const connectionId2 = body?.connectionId2;

    if (!connectionId1 || !connectionId2) {
      return NextResponse.json(
        { error: "connectionId1 and connectionId2 are required" },
        { status: 400 },
      );
    }

    if (connectionId1 === connectionId2) {
      return NextResponse.json({ success: true });
    }

    const ok = await swapProviderConnectionPriorities(connectionId1, connectionId2);
    if (!ok) {
      return NextResponse.json(
        { error: "Connections not found or belong to different providers" },
        { status: 404 },
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error swapping connection priorities:", error?.message || error);
    return NextResponse.json({ error: "Failed to swap connection priorities" }, { status: 500 });
  }
}
