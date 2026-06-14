import { NextResponse } from "next/server";
import { providerReachability } from "open-sse/utils/circuitBreaker.js";
import { getPendingRequestTotal } from "@/lib/usageDb.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export async function GET() {
  let dbOk = true;
  try {
    const { getAdapter } = await import("@/lib/db/driver.js");
    await getAdapter();
  } catch {
    dbOk = false;
  }

  const body = { ok: dbOk, db: dbOk };

  try {
    body.uptime_seconds = Math.floor(process.uptime());
  } catch {
    body.ok = false;
  }

  try {
    body.active_connections = getPendingRequestTotal();
  } catch {
    body.ok = false;
  }

  try {
    const reachability = providerReachability.getAll();
    body.providers = {};
    body.last_errors = {};
    for (const [name, entry] of Object.entries(reachability)) {
      body.providers[name] = { reachable: entry.reachable };
      body.last_errors[name] = entry.lastErrorAt;
    }
  } catch {
    body.ok = false;
  }

  return NextResponse.json(
    body,
    { headers: CORS_HEADERS, status: body.ok ? 200 : 503 }
  );
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
