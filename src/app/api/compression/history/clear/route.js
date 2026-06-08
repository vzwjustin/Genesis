import { NextResponse } from "next/server";
import { clearCompressionHistory } from "@/lib/compressionStats";

export async function POST() {
  const deleted = await clearCompressionHistory();
  return NextResponse.json({ success: true, deleted });
}
