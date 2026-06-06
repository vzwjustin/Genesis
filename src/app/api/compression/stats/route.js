import { NextResponse } from "next/server";
import { getCompressionStats } from "@/lib/compressionStats";
import { getHeadroomProxyStats } from "open-sse/rtk/headroom.js";

export const dynamic = "force-dynamic";

export async function GET() {
  const [stats, headroomProxy] = await Promise.all([
    getCompressionStats(),
    getHeadroomProxyStats(),
  ]);
  return NextResponse.json({ ...stats, headroomProxy });
}
