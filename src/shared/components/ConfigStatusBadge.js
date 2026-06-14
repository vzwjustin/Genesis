"use client";

import { cn } from "@/shared/utils/cn";

const STYLES = {
  configured: "bg-success/10 text-success",
  connected: "bg-success/10 text-success",
  not_configured: "bg-warning/10 text-warning",
  other: "bg-info/10 text-info",
  not_installed: "glass-badge text-text-muted",
  remote_setup: "bg-info/10 text-info",
  unknown: "glass-badge text-text-muted",
};

const LABELS = {
  configured: "Connected",
  connected: "Connected",
  not_configured: "Not configured",
  other: "Other",
  not_installed: "Not installed",
  remote_setup: "Manual setup",
  unknown: "Unknown",
};

/** CLI tool connection status pill (header badges + summary cards). */
export default function ConfigStatusBadge({ status, className }) {
  if (!status) return null;
  const key = status in STYLES ? status : "unknown";
  return (
    <span
      className={cn(
        "inline-block px-1.5 py-0.5 text-[10px] font-medium rounded-full",
        STYLES[key],
        className
      )}
    >
      {LABELS[key]}
    </span>
  );
}

export function getToolInstallStatus(status, toolConfig) {
  if (!status) {
    if (toolConfig?.configType === "guide") return { status: "not_configured" };
    return { status: "unknown" };
  }
  if (status.fetchFailed) return { status: "unknown" };
  if (!status.installed) return { status: "remote_setup" };
  if (status.hasGenesis) return { status: "connected" };
  return { status: "not_configured" };
}

/** True when the tool is installed and points at genesis (badge: "Connected"). */
export function isCliToolConfigured(status) {
  return getToolInstallStatus(status).status === "connected";
}
