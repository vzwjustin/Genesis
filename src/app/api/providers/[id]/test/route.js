import { NextResponse } from "next/server";
import { testSingleConnection } from "./testUtils.js";
import { requireSpawnRouteAuth } from "@/lib/auth/spawnRouteAuth";

// POST /api/providers/[id]/test - Test connection
export async function POST(request, { params }) {
  try {
    const auth = await requireSpawnRouteAuth(request);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { id } = await params;
    const result = await testSingleConnection(id);

    if (result.error === "Connection not found") {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    return NextResponse.json({
      valid: result.valid,
      error: result.error,
      refreshed: result.refreshed || false,
    });
  } catch (error) {
    console.error("Error testing connection:", error?.message);
    return NextResponse.json({ error: "Test failed" }, { status: 500 });
  }
}
