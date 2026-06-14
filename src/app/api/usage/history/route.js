import { NextResponse } from "next/server";
import { getUsageHistory } from "@/lib/usageDb";
import { requireDashboardApiAuth, parseIsoDateParam } from "@/lib/auth/dashboardApiAuth";

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5000;

export async function GET(request) {
  try {
    const auth = await requireDashboardApiAuth(request);
    if (!auth.ok) return auth.response;

    const { searchParams } = new URL(request.url);
    const provider = searchParams.get("provider");
    const model = searchParams.get("model");
    const startDateRaw = searchParams.get("startDate");
    const endDateRaw = searchParams.get("endDate");

    const startParsed = parseIsoDateParam(startDateRaw, "startDate");
    if (!startParsed.ok) {
      return NextResponse.json({ error: startParsed.error }, { status: 400 });
    }
    const endParsed = parseIsoDateParam(endDateRaw, "endDate");
    if (!endParsed.ok) {
      return NextResponse.json({ error: endParsed.error }, { status: 400 });
    }

    let limit = parseInt(searchParams.get("limit") || String(DEFAULT_LIMIT), 10);
    if (!Number.isFinite(limit) || limit < 1) limit = DEFAULT_LIMIT;
    if (limit > MAX_LIMIT) limit = MAX_LIMIT;

    const filter = { limit };
    if (provider) filter.provider = provider;
    if (model) filter.model = model;
    if (startParsed.value) filter.startDate = startParsed.value;
    if (endParsed.value) filter.endDate = endParsed.value;

    const history = await getUsageHistory(filter);
    return NextResponse.json({ history, limit });
  } catch (error) {
    console.error("Error fetching usage history:", error);
    return NextResponse.json({ error: "Failed to fetch usage history" }, { status: 500 });
  }
}
