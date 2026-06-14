"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { Button, CardSkeleton, SegmentedControl, EmptyState, InlineAlert } from "@/shared/components";
import { CLI_TOOLS, MITM_TOOLS } from "@/shared/constants/cliTools";
import { isCliToolConfigured } from "@/shared/components/ConfigStatusBadge";
import { useHeaderSearchStore } from "@/store/headerSearchStore";
import { useNotificationStore } from "@/store/notificationStore";
import { MitmLinkCard } from "./components";
import ToolSummaryCard from "./components/ToolSummaryCard";

const ALL_STATUSES_URL = "/api/cli-tools/all-statuses";
const MITM_STATUS_URL = "/api/cli-tools/antigravity-mitm";

const FILTER_OPTIONS = [
  { value: "all", label: "All" },
  { value: "configured", label: "Configured" },
  { value: "unconfigured", label: "Not configured" },
];

export default function CLIToolsPageClient({ machineId }) {
  const notify = useNotificationStore();
  const searchQuery = useHeaderSearchStore((s) => s.query);
  const registerSearch = useHeaderSearchStore((s) => s.register);
  const unregisterSearch = useHeaderSearchStore((s) => s.unregister);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [toolStatuses, setToolStatuses] = useState({});
  const [mitmStatus, setMitmStatus] = useState(null);
  const [filter, setFilter] = useState("all");
  const [statusError, setStatusError] = useState(null);

  const fetchStatuses = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    else setRefreshing(true);
    try {
      const fetchOpts = { cache: "no-store", credentials: "same-origin" };
      const [statusRes, mitmRes] = await Promise.all([
        fetch(ALL_STATUSES_URL, fetchOpts),
        fetch(MITM_STATUS_URL, fetchOpts),
      ]);
      if (statusRes.ok) {
        setToolStatuses(await statusRes.json());
        setStatusError(null);
      } else {
        const errBody = await statusRes.json().catch(() => ({}));
        const message = errBody?.error || `HTTP ${statusRes.status}`;
        setStatusError(message);
        notify.error(message);
      }
      if (mitmRes.ok) setMitmStatus(await mitmRes.json());
    } catch (error) {
      setStatusError(error?.message || "Failed to refresh tool statuses");
      notify.error(error?.message || "Failed to refresh tool statuses");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [notify]);

  useEffect(() => {
    registerSearch("Search CLI tools…");
    fetchStatuses(true);
    return () => unregisterSearch();
  }, [registerSearch, unregisterSearch, fetchStatuses]);

  const regularTools = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return Object.entries(CLI_TOOLS).filter(([toolId, tool]) => {
      if (q) {
        const hay = `${tool.name} ${tool.description} ${toolId}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (filter === "all") return true;
      if (filter === "configured") return isCliToolConfigured(toolStatuses[toolId]);
      return !isCliToolConfigured(toolStatuses[toolId]);
    });
  }, [filter, toolStatuses, searchQuery]);

  if (loading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
        <CardSkeleton />
        <CardSkeleton />
        <CardSkeleton />
        <CardSkeleton />
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  const mitmTools = Object.entries(MITM_TOOLS);
  const toolIds = Object.keys(CLI_TOOLS);
  const configuredCount = toolIds.filter((id) => isCliToolConfigured(toolStatuses[id])).length;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-1 sm:px-0">
      {statusError && (
        <InlineAlert
          variant="error"
          title="Could not load CLI tool statuses"
          message={`${statusError}. Try logging out and back in, then click Refresh.`}
        />
      )}
      <div className="flex flex-col gap-3 px-1 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-text-muted">
          <span className="font-medium text-text-main">{configuredCount}/{toolIds.length}</span> CLI tools configured
          {mitmStatus?.running && (
            <span className="ml-2 text-success text-xs">· MITM server running</span>
          )}
        </p>
        <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
          <Button size="sm" variant="ghost" icon="refresh" loading={refreshing} onClick={() => fetchStatuses(false)}>
            Refresh
          </Button>
          <SegmentedControl
            options={FILTER_OPTIONS}
            value={filter}
            onChange={setFilter}
            size="sm"
            className="w-full sm:w-auto"
          />
        </div>
      </div>

      {regularTools.length === 0 ? (
        <EmptyState
          borderless
          icon="filter_alt"
          title="No tools match this filter"
          description="Try a different filter or configure a tool from the All view."
          action={{ label: "Show all", onClick: () => setFilter("all") }}
          className="py-8"
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
          {regularTools.map(([toolId, tool]) => (
            <ToolSummaryCard key={toolId} toolId={toolId} tool={tool} status={toolStatuses[toolId]} />
          ))}
        </div>
      )}

      <div className="flex flex-col gap-3 sm:gap-4 glass-panel p-4 sm:p-5">
        <div className="flex flex-col gap-0.5 px-1">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[18px] text-primary">security</span>
            <h2 className="text-sm font-semibold text-text-main">MITM Tools</h2>
          </div>
          <p className="text-xs text-text-muted">
            IDE tools that need traffic interception (MITM) to route their requests through genesis.
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
          {mitmTools.map(([toolId, tool]) => (
            <MitmLinkCard
              key={toolId}
              tool={tool}
              dnsEnabled={!!mitmStatus?.dnsStatus?.[toolId]}
              serverRunning={!!mitmStatus?.running}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
