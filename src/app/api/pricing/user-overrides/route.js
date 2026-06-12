import { NextResponse } from "next/server";
import { getUserPricingOverrides } from "@/lib/localDb.js";

/** GET /api/pricing/user-overrides — raw user pricing overrides (not merged with defaults) */
export async function GET() {
  try {
    const overrides = await getUserPricingOverrides();
    return NextResponse.json(overrides);
  } catch (error) {
    console.error("Error fetching pricing overrides:", error);
    return NextResponse.json({ error: "Failed to fetch pricing overrides" }, { status: 500 });
  }
}
