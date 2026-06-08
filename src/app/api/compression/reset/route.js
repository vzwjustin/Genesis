import { NextResponse } from "next/server";
import { resetCompressionStats } from "@/lib/compressionStats";

export async function POST() {
  const stats = await resetCompressionStats();
  return NextResponse.json({ success: true, stats });
}
