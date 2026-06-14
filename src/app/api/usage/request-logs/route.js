import { NextResponse } from "next/server";
import { getRecentLogs } from "@/lib/usageDb";
import { requireDashboardApiAuth } from "@/lib/auth/dashboardApiAuth";

export async function GET(request) {
  try {
    const auth = await requireDashboardApiAuth(request);
    if (!auth.ok) return auth.response;

    const logs = await getRecentLogs(200);
    return NextResponse.json(logs);
  } catch (error) {
    console.error("[API ERROR] /api/usage/logs failed:", error);
    console.error("[API ERROR] Stack:", error?.stack);
    return NextResponse.json({ error: "Failed to fetch logs" }, { status: 500 });
  }
}
