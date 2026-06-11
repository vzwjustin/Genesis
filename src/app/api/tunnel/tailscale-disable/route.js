import { NextResponse } from "next/server";
import { disableTailscale } from "@/lib/tunnel";
import { requireSpawnRouteAuth } from "@/lib/auth/spawnRouteAuth";

export async function POST(request) {
  const auth = await requireSpawnRouteAuth(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  try {
    const result = await disableTailscale();
    return NextResponse.json(result);
  } catch (error) {
    console.error("Tailscale disable error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
