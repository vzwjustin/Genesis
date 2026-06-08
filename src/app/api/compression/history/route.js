import { NextResponse } from "next/server";
import { getCompressionStatsHistory } from "@/lib/compressionStats";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const subsystem = searchParams.get("subsystem") || undefined;
  const since = searchParams.get("since") || undefined;
  const limitRaw = Number(searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 100;

  const rows = await getCompressionStatsHistory({ subsystem, since, limit });

  return NextResponse.json({
    rows: rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      subsystem: row.subsystem,
      bytesBefore: row.bytes_before,
      bytesAfter: row.bytes_after,
      bytesSaved: Math.max(0, (row.bytes_before || 0) - (row.bytes_after || 0)),
      filterHits: row.filter_hits,
      level: row.level,
    })),
  });
}
