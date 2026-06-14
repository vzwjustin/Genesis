import { NextResponse } from "next/server";
import { getUserPricingOverrides } from "@/lib/localDb.js";
import { requireSpawnRouteAuth } from "@/lib/auth/spawnRouteAuth";

/** GET /api/pricing/user-overrides — raw user pricing overrides (not merged with defaults) */
export async function GET(request) {
  const auth = await requireSpawnRouteAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    const overrides = await getUserPricingOverrides();
    return NextResponse.json(overrides);
  } catch (error) {
    console.error("Error fetching pricing overrides:", error);
    return NextResponse.json({ error: "Failed to fetch pricing overrides" }, { status: 500 });
  }
}
