"use client";

import { cn } from "@/shared/utils/cn";

const STYLES = {
  configured: "bg-green-500/10 text-green-600 dark:text-green-400",
  connected: "bg-green-500/10 text-green-600 dark:text-green-400",
  not_configured: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  other: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  not_installed: "bg-gray-500/10 text-gray-500",
  unknown: "bg-gray-500/10 text-gray-500",
};

const LABELS = {
  configured: "Connected",
  connected: "Connected",
  not_configured: "Not configured",
  other: "Other",
  not_installed: "Not installed",
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

export function getToolInstallStatus(status) {
  if (!status) return { status: "unknown" };
  if (!status.installed) return { status: "not_installed" };
  if (status.has9Router) return { status: "connected" };
  return { status: "not_configured" };
}

/** True when the tool is installed and points at 9router (badge: "Connected"). */
export function isCliToolConfigured(status) {
  return getToolInstallStatus(status).status === "connected";
}
