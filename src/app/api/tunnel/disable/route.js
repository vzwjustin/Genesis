import { NextResponse } from "next/server";
import { disableTunnel } from "@/lib/tunnel";
import { requireSpawnRouteAuth } from "@/lib/auth/spawnRouteAuth";

export async function POST(request) {
  const auth = await requireSpawnRouteAuth(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  try {
    const result = await disableTunnel();
    return NextResponse.json(result);
  } catch (error) {
    console.error("Tunnel disable error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
