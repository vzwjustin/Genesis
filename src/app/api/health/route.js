import { NextResponse } from "next/server";

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

  return NextResponse.json(
    { ok: dbOk, db: dbOk },
    { headers: CORS_HEADERS, status: dbOk ? 200 : 503 }
  );
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
