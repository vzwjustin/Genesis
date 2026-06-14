import { NextResponse } from "next/server";
import { getRequestDetails } from "@/lib/usageDb";
import { requireDashboardApiAuth, parseIsoDateParam } from "@/lib/auth/dashboardApiAuth";

const MAX_PAGE = 10000;

/**
 * GET /api/usage/request-details
 * Query parameters: page, pageSize (1-100), provider, model, connectionId, status, startDate, endDate
 */
export async function GET(request) {
  try {
    const auth = await requireDashboardApiAuth(request);
    if (!auth.ok) return auth.response;

    const { searchParams } = new URL(request.url);

    const page = parseInt(searchParams.get("page")) || 1;
    const pageSize = parseInt(searchParams.get("pageSize")) || 20;
    const provider = searchParams.get("provider");
    const model = searchParams.get("model");
    const connectionId = searchParams.get("connectionId");
    const status = searchParams.get("status");
    const startDateRaw = searchParams.get("startDate");
    const endDateRaw = searchParams.get("endDate");

    if (page < 1) {
      return NextResponse.json(
        { error: "Page must be >= 1" },
        { status: 400 }
      );
    }

    if (page > MAX_PAGE) {
      return NextResponse.json(
        { error: `Page must be <= ${MAX_PAGE}` },
        { status: 400 }
      );
    }

    if (pageSize < 1 || pageSize > 100) {
      return NextResponse.json(
        { error: "PageSize must be between 1 and 100" },
        { status: 400 }
      );
    }

    const startParsed = parseIsoDateParam(startDateRaw, "startDate");
    if (!startParsed.ok) {
      return NextResponse.json({ error: startParsed.error }, { status: 400 });
    }
    const endParsed = parseIsoDateParam(endDateRaw, "endDate");
    if (!endParsed.ok) {
      return NextResponse.json({ error: endParsed.error }, { status: 400 });
    }

    const filter = {
      page,
      pageSize
    };

    if (provider) filter.provider = provider;
    if (model) filter.model = model;
    if (connectionId) filter.connectionId = connectionId;
    if (status) filter.status = status;
    if (startParsed.value) filter.startDate = startParsed.value;
    if (endParsed.value) filter.endDate = endParsed.value;

    const result = await getRequestDetails(filter);

    return NextResponse.json(result);
  } catch (error) {
    console.error("[API] Failed to get request details:", error);
    return NextResponse.json(
      { error: "Failed to fetch request details" },
      { status: 500 }
    );
  }
}
