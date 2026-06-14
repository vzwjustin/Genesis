"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { Button, Skeleton } from "@/shared/components";
import { CLI_TOOLS } from "@/shared/constants/cliTools";
import { isCliToolConfigured } from "@/shared/components/ConfigStatusBadge";
import { getRelativeTime } from "@/shared/utils";
import { AI_PROVIDERS } from "@/shared/constants/providers";

const POLL_INTERVAL_MS = 15000;

function getConnectionStatus(conn) {
  if (conn.isActive === false) return "disabled";
  const s = conn.testStatus;
  if (s === "active" || s === "success") return "ok";
  if (s === "error" || s === "expired") return "error";
  if (s === "unavailable") return "unavailable";
  return "unknown";
}

function getProviderLabel(conn) {
  if (conn.name) return conn.name;
  const info = AI_PROVIDERS[conn.provider];
  return info?.name || conn.provider;
}

function StatusDot({ status, size = "sm" }) {
  const cls = {
    ok: "bg-success",
    error: "bg-danger",
    unavailable: "bg-warning",
    disabled: "bg-surface-3",
    unknown: "bg-text-subtle",
  }[status] || "bg-text-subtle";
  const sz = size === "sm" ? "size-2" : "size-2.5";
  return <span className={`inline-block rounded-full shrink-0 ${sz} ${cls}`} />;
}

function HealthPill({ icon, label, value, href, status, tint = "neutral" }) {
  const colorMap = {
    ok: "text-success",
    error: "text-danger",
    warning: "text-warning",
    muted: "text-text-muted",
  };
  const tintMap = {
    success: "glass-stat-tint-success",
    info: "glass-stat-tint-info",
    neutral: "glass-stat-tint-neutral",
  };
  const valueColor = status === "ok" ? "text-success" : status === "error" ? "text-danger" : "text-text-main";
  const inner = (
    <div className={`glass-stat ${tintMap[tint] || tintMap.neutral} flex min-w-0 flex-col gap-1 p-4 transition-shadow`}>
      <div className="flex items-center gap-1.5 text-xs text-text-muted">
        <span className={`material-symbols-outlined text-[14px] ${colorMap[status] || "text-text-muted"}`}>{icon}</span>
        <span>{label}</span>
      </div>
      <span className={`text-lg font-semibold tracking-tight ${valueColor}`}>
        {value}
      </span>
    </div>
  );
  return href ? <Link href={href} className="block min-w-[140px] flex-1">{inner}</Link> : inner;
}

function SkeletonStat() {
  return <Skeleton className="h-[76px] flex-1 rounded-[14px]" />;
}

function SetupStepper({ steps }) {
  const doneCount = steps.filter((s) => s.done).length;
  return (
    <div className="glass-panel p-5 sm:p-6">
      <div className="mb-5 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm font-medium text-text-main">Setup checklist</p>
        <p className="text-xs text-text-muted">
          {doneCount}/{steps.length} complete · Security provider and recommended
        </p>
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 sm:gap-2">
        {steps.map((step, index) => {
          const prevDone = index === 0 || steps[index - 1].done;
          const lineDone = step.done && prevDone;
          return (
            <div key={step.label} className="relative flex flex-col items-center text-center px-1">
              {index > 0 && (
                <div
                  className={`hidden sm:block absolute top-4 right-[calc(50%+16px)] h-0.5 w-[calc(100%-32px)] -translate-y-1/2 ${lineDone ? "bg-success" : "bg-border"}`}
                  aria-hidden
                />
              )}
              <div
                className={`relative z-10 flex size-8 items-center justify-center rounded-full border ${
                  step.done
                    ? "step-done"
                    : "border-slate-200 bg-white text-slate-400"
                }`}
              >
                {step.done ? (
                  <span className="material-symbols-outlined text-[18px]">check</span>
                ) : (
                  <span className="text-xs font-medium">{index + 1}</span>
                )}
              </div>
              <Link
                href={step.href}
                className={`mt-2.5 text-[11px] leading-snug sm:text-xs ${step.done ? "text-text-muted" : "text-text-muted hover:text-text-main"}`}
              >
                {step.label}
              </Link>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PanelCard({ title, icon, actionHref, actionLabel, children }) {
  return (
    <div className="glass-panel p-4 sm:p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-medium text-text-main">
          <span className="material-symbols-outlined text-[16px] text-text-muted">{icon}</span>
          {title}
        </h2>
        {actionHref ? (
          <Link href={actionHref} className="text-xs font-medium text-brand-500 hover:text-brand-600 transition-colors">
            {actionLabel}
          </Link>
        ) : null}
      </div>
      {children}
    </div>
  );
}

export default function DashboardOverviewClient() {
  const [loading, setLoading] = useState(true);
  const [connections, setConnections] = useState([]);
  const [cliStats, setCli] = useState({ configured: 0, total: 0 });
  const [usageStats, setUsageStats] = useState(null);
  const [tunnelStatus, setTunnelStatus] = useState(null);
  const [requireApiKey, setRequireApiKey] = useState(false);

  const refresh = useCallback(async (cancelled) => {
    try {
      const [providersRes, cliRes, usageRes, tunnelRes, settingsRes] = await Promise.all([
        fetch("/api/providers"),
        fetch("/api/cli-tools/all-statuses"),
        fetch("/api/usage/stats?period=today"),
        fetch("/api/tunnel/status", { cache: "no-store" }),
        fetch("/api/settings", { cache: "no-store" }),
      ]);
      if (cancelled?.()) return;
      if (providersRes.ok) setConnections((await providersRes.json()).connections || []);
      if (cliRes.ok) {
        const statuses = await cliRes.json();
        const toolIds = Object.keys(CLI_TOOLS);
        let configured = 0;
        for (const id of toolIds) if (isCliToolConfigured(statuses[id])) configured++;
        setCli({ configured, total: toolIds.length });
      }
      if (usageRes.ok) setUsageStats(await usageRes.json());
      if (tunnelRes.ok) setTunnelStatus(await tunnelRes.json());
      if (settingsRes.ok) {
        const s = await settingsRes.json();
        setRequireApiKey(s.requireApiKey === true);
      }
    } catch { /* ignore */ }
    finally { if (!cancelled?.()) setLoading(false); }
  }, []);

  useEffect(() => {
    let dead = false;
    refresh(() => dead);
    const id = setInterval(() => { if (!document.hidden) refresh(() => dead); }, POLL_INTERVAL_MS);
    const onVisible = () => { if (!document.hidden) refresh(() => dead); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { dead = true; clearInterval(id); document.removeEventListener("visibilitychange", onVisible); };
  }, [refresh]);

  // Derived health values
  const activeConns = connections.filter(c => c.isActive !== false);
  const errorConns = activeConns.filter(c => getConnectionStatus(c) === "error");
  const providerStatus = errorConns.length > 0 ? "error" : activeConns.length > 0 ? "ok" : "muted";

  const tunnelOn = tunnelStatus?.tunnel?.settingsEnabled || tunnelStatus?.tunnel?.enabled;
  const tailscaleOn = tunnelStatus?.tailscale?.settingsEnabled || tunnelStatus?.tailscale?.enabled;
  const remoteOn = tunnelOn || tailscaleOn;
  const remoteStatus = remoteOn ? "ok" : "muted";

  const requestsToday = usageStats?.totalRequests ?? null;
  const recentRequests = (usageStats?.recentRequests || []).slice(0, 8);

  const setupSteps = [
    { done: activeConns.length > 0, label: "Connect a provider", href: "/dashboard/providers" },
    { done: requireApiKey, label: "Enable API key requirement (recommended)", href: "/dashboard/endpoint#require-api-key" },
    { done: cliStats.configured > 0, label: "Configure a CLI tool", href: "/dashboard/cli-tools" },
    { done: remoteOn, label: "Optional: enable tunnel for remote access", href: "/dashboard/endpoint" },
  ];
  const setupComplete = setupSteps.filter((s) => s.done).length;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">

      {!loading && setupComplete < setupSteps.length && (
        <SetupStepper steps={setupSteps} />
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {loading ? (
          <>
            <SkeletonStat /><SkeletonStat /><SkeletonStat /><SkeletonStat />
          </>
        ) : (
          <>
            <HealthPill
              icon="dns"
              label="Providers"
              value={activeConns.length === 0 ? "None" : errorConns.length > 0 ? `${errorConns.length} error` : `${activeConns.length} connected`}
              status={providerStatus}
              tint={providerStatus === "ok" ? "info" : "neutral"}
              href="/dashboard/providers"
            />
            <HealthPill
              icon="public"
              label="Remote"
              value={remoteOn ? "On" : "Off"}
              status={remoteStatus}
              tint="neutral"
              href="/dashboard/endpoint"
            />
            <HealthPill
              icon="terminal"
              label="CLI tools"
              value={cliStats.total ? `${cliStats.configured}/${cliStats.total}` : "None"}
              status={cliStats.configured > 0 ? "ok" : "muted"}
              tint="neutral"
              href="/dashboard/cli-tools"
            />
            <HealthPill
              icon="bar_chart"
              label="Today"
              value={requestsToday != null ? new Intl.NumberFormat().format(requestsToday) : "—"}
              status={requestsToday > 0 ? "ok" : "muted"}
              tint={requestsToday > 0 ? "success" : "neutral"}
              href="/dashboard/usage"
            />
          </>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <PanelCard title="Provider Health" icon="dns" actionHref="/dashboard/providers" actionLabel="Manage">
          {loading ? (
            <div className="flex flex-col gap-2">
              {[1, 2, 3].map((i) => <Skeleton key={i} className="h-11 rounded-lg" />)}
            </div>
          ) : activeConns.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <span className="material-symbols-outlined text-text-subtle text-[28px]">dns</span>
              <p className="text-sm text-text-muted">No providers connected</p>
              <Link href="/dashboard/providers">
                <Button size="sm" variant="outline">Add provider</Button>
              </Link>
            </div>
          ) : (
            <div className="flex flex-col gap-0.5">
              {activeConns.slice(0, 8).map((conn) => {
                const status = getConnectionStatus(conn);
                const label = getProviderLabel(conn);
                const provInfo = AI_PROVIDERS[conn.provider];
                const provBrand = provInfo?.name || conn.provider?.toUpperCase() || "—";
                return (
                  <Link
                    key={conn.id}
                    href={`/dashboard/providers/${conn.provider}`}
                    className="flex items-center gap-3 rounded-lg px-2 py-2.5 transition-colors dashboard-row-hover group"
                  >
                    <StatusDot status={status} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate text-text-main">{label}</p>
                      {provBrand !== label && (
                        <p className="text-xs text-text-muted truncate">{provBrand}</p>
                      )}
                    </div>
                    {conn.lastErrorAt && status === "error" && (
                      <span className="text-xs text-text-subtle shrink-0">{getRelativeTime(conn.lastErrorAt)}</span>
                    )}
                    {status === "error" && (
                      <span className="shrink-0 rounded-md border border-danger/30 bg-danger/10 px-2 py-0.5 text-[10px] font-medium text-danger">Error</span>
                    )}
                    {status === "ok" && (
                      <span className="shrink-0 rounded-md border border-success/30 bg-success/10 px-2 py-0.5 text-[10px] font-medium text-success">OK</span>
                    )}
                  </Link>
                );
              })}
              {activeConns.length > 8 && (
                <div className="pt-2 px-2">
                  <Link href="/dashboard/providers" className="text-xs text-brand-500 hover:text-brand-600">
                    +{activeConns.length - 8} more providers
                  </Link>
                </div>
              )}
            </div>
          )}
        </PanelCard>

        <PanelCard title="Recent Requests" icon="history" actionHref="/dashboard/usage" actionLabel="View all">
          {loading ? (
            <div className="flex flex-col gap-2">
              {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-10 rounded-lg" />)}
            </div>
          ) : recentRequests.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <span className="material-symbols-outlined text-text-subtle text-[28px]">history</span>
              <p className="text-sm text-text-muted">No requests yet</p>
            </div>
          ) : (
            <div className="flex flex-col gap-0.5">
              {recentRequests.map((r, i) => {
                const tokens = (r.promptTokens || 0) + (r.completionTokens || 0);
                const isError = r.status && r.status !== "ok" && r.status !== "success";
                return (
                  <div key={i} className="flex items-center gap-2 rounded-lg px-2 py-2 min-w-0">
                    <span className={`shrink-0 material-symbols-outlined text-[14px] ${isError ? "text-danger" : "text-success"}`}>
                      {isError ? "error" : "check_circle"}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-mono truncate text-text-main">{r.model || "—"}</p>
                      <p className="text-[11px] text-text-muted truncate">{r.provider?.toUpperCase() || "—"}</p>
                    </div>
                    <div className="shrink-0 text-right">
                      {tokens > 0 && (
                        <p className="text-xs text-text-muted tabular-nums">{new Intl.NumberFormat().format(tokens)} tok</p>
                      )}
                      <p className="text-[11px] text-text-subtle">{getRelativeTime(r.timestamp)}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </PanelCard>
      </div>
    </div>
  );
}
