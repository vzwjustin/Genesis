import { NextResponse } from "next/server";
import { getProviderCompressionStats } from "@/lib/compressionStats";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const period = searchParams.get("period") || "7d";
  const provider = searchParams.get("provider") || undefined;

  const stats = await getProviderCompressionStats(period, { provider });

  return NextResponse.json({
    ...stats,
    updatedAt: new Date().toISOString(),
  });
}
