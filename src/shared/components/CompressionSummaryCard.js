"use client";

import Link from "next/link";
import { Card, Button, Badge } from "@/shared/components";
import CompressionStatRow, { formatBytes } from "@/shared/components/CompressionStatRow";

export default function CompressionSummaryCard({
  compressionStats,
  headroomStatus,
  rtkEnabled,
  cavemanEnabled,
  headroomEnabled,
  passthroughCompression,
}) {
  const tools = compressionStats?.tools || {};
  const totalSaved =
    (tools.rtk?.bytesSaved || 0) +
    (tools.headroom?.bytesSaved || 0);

  const headroomDashboardUrl =
    compressionStats?.headroomProxy?.dashboardUrl ||
    (headroomStatus?.reachable ? `${headroomStatus.proxyUrl}/dashboard` : null);

  return (
    <Card id="rtk">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold flex items-center gap-2 mb-1">
            <span className="material-symbols-outlined text-primary">bolt</span>
            Token Saver
          </h2>
          <p className="text-sm text-text-muted mb-3">
            RTK, Headroom, and Caveman compression — configure on the Caching page.
          </p>
          <div className="flex flex-wrap gap-2 mb-3">
            <Badge variant={rtkEnabled ? "success" : "default"} size="sm">RTK {rtkEnabled ? "on" : "off"}</Badge>
            <Badge variant={headroomEnabled ? "success" : "default"} size="sm">Headroom {headroomEnabled ? "on" : "off"}</Badge>
            <Badge variant={cavemanEnabled ? "success" : "default"} size="sm">Caveman {cavemanEnabled ? "on" : "off"}</Badge>
            <Badge variant={passthroughCompression ? "warning" : "default"} size="sm">
              Passthrough {passthroughCompression ? "on" : "off"}
            </Badge>
          </div>
          {totalSaved > 0 && (
            <p className="text-sm font-medium text-success tabular-nums">
              {formatBytes(totalSaved)} saved recently
            </p>
          )}
        </div>
        <Link href="/dashboard/caching">
          <Button size="sm" variant="secondary" icon="tune">Manage compression</Button>
        </Link>
      </div>

      <div className="mt-4 pt-4 border-t border-border grid grid-cols-1 md:grid-cols-3 gap-4">
        <div>
          <p className="text-xs font-semibold text-text-muted mb-1">RTK</p>
          <CompressionStatRow stats={tools.rtk} kind="bytes" emptyHint="No RTK activity yet" />
        </div>
        <div>
          <p className="text-xs font-semibold text-text-muted mb-1">Headroom</p>
          <CompressionStatRow
            stats={tools.headroom}
            proxyStats={compressionStats?.headroomProxy}
            kind="bytes"
            dashboardUrl={headroomDashboardUrl}
            emptyHint={headroomStatus?.reachable ? "No Headroom savings yet" : "Headroom proxy not reachable"}
          />
        </div>
        <div>
          <p className="text-xs font-semibold text-text-muted mb-1">Caveman</p>
          <CompressionStatRow stats={tools.caveman} kind="injections" emptyHint="No Caveman injections yet" />
        </div>
      </div>
    </Card>
  );
}
