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
  let degraded = false;

  try {
    body.uptime_seconds = Math.floor(process.uptime());
  } catch {
    degraded = true;
  }

  try {
    body.active_connections = getPendingRequestTotal();
  } catch {
    degraded = true;
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
    degraded = true;
  }

  if (degraded) {
    body.degraded = true;
  }

  return NextResponse.json(
    body,
    { headers: CORS_HEADERS, status: dbOk ? 200 : 503 }
  );
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
