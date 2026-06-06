"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, Button, Skeleton } from "@/shared/components";
import { useDashboardSecurity } from "@/shared/hooks/useDashboardSecurity";
import { CLI_TOOLS } from "@/shared/constants/cliTools";
import { isCliToolConfigured } from "@/shared/components/ConfigStatusBadge";

const QUICK_LINKS = [
  { href: "/dashboard/endpoint", label: "Endpoint", icon: "api", desc: "URLs, tunnel, API keys" },
  { href: "/dashboard/providers", label: "Providers", icon: "dns", desc: "Connect AI accounts" },
  { href: "/dashboard/cli-tools", label: "CLI Tools", icon: "terminal", desc: "Point local tools here" },
  { href: "/dashboard/basic-chat", label: "Basic Chat", icon: "chat", desc: "Chat with connected models" },
  { href: "/dashboard/usage", label: "Usage", icon: "bar_chart", desc: "Tokens, costs, request logs" },
  { href: "/dashboard/combos", label: "Combos", icon: "layers", desc: "Model failover chains" },
  { href: "/dashboard/profile", label: "Security", icon: "shield", desc: "Password and login" },
];

function StatCardSkeleton() {
  return (
    <Card padding="sm">
      <Skeleton className="h-3 w-20 mb-2" />
      <Skeleton className="h-8 w-14 mb-2" />
      <Skeleton className="h-3 w-24" />
    </Card>
  );
}

function formatRequestCount(n) {
  if (n == null) return "—";
  return new Intl.NumberFormat().format(n);
}

export default function DashboardOverviewClient() {
  const security = useDashboardSecurity();
  const [loading, setLoading] = useState(true);
  const [providerCount, setProviderCount] = useState(null);
  const [cliStats, setCliStats] = useState({ configured: 0, total: 0 });
  const [requestsToday, setRequestsToday] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [providersRes, cliRes, usageRes] = await Promise.all([
          fetch("/api/providers"),
          fetch("/api/cli-tools/all-statuses"),
          fetch("/api/usage/stats?period=today"),
        ]);
        if (cancelled) return;
        if (providersRes.ok) {
          const data = await providersRes.json();
          setProviderCount((data.connections || []).length);
        }
        if (cliRes.ok) {
          const statuses = await cliRes.json();
          const toolIds = Object.keys(CLI_TOOLS);
          let configured = 0;
          for (const id of toolIds) {
            if (isCliToolConfigured(statuses[id])) configured++;
          }
          setCliStats({ configured, total: toolIds.length });
        }
        if (usageRes.ok) {
          const usage = await usageRes.json();
          setRequestsToday(usage.totalRequests ?? 0);
        }
      } catch {
        /* ignore */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {loading ? (
          <>
            <StatCardSkeleton />
            <StatCardSkeleton />
            <StatCardSkeleton />
            <StatCardSkeleton />
          </>
        ) : (
          <>
            <Card padding="sm">
              <div className="flex items-center gap-2 mb-1">
                <span className="material-symbols-outlined text-primary text-[16px]">dns</span>
                <p className="text-xs text-text-muted">Providers</p>
              </div>
              <p className="text-2xl font-semibold">{providerCount ?? "—"}</p>
              <Link href="/dashboard/providers" className="text-xs text-primary mt-2 inline-block hover:underline">
                Manage providers
              </Link>
            </Card>
            <Card padding="sm">
              <div className="flex items-center gap-2 mb-1">
                <span className="material-symbols-outlined text-primary text-[16px]">terminal</span>
                <p className="text-xs text-text-muted">CLI tools configured</p>
              </div>
              <p className="text-2xl font-semibold">
                {cliStats.total ? `${cliStats.configured}/${cliStats.total}` : "—"}
              </p>
              <Link href="/dashboard/cli-tools" className="text-xs text-primary mt-2 inline-block hover:underline">
                Configure tools
              </Link>
            </Card>
            <Card padding="sm">
              <div className="flex items-center gap-2 mb-1">
                <span className="material-symbols-outlined text-primary text-[16px]">bar_chart</span>
                <p className="text-xs text-text-muted">Requests today</p>
              </div>
              <p className="text-2xl font-semibold">{formatRequestCount(requestsToday)}</p>
              <Link href="/dashboard/usage" className="text-xs text-primary mt-2 inline-block hover:underline">
                View usage
              </Link>
            </Card>
            <Card padding="sm">
              <div className="flex items-center gap-2 mb-1">
                <span className="material-symbols-outlined text-primary text-[16px]">public</span>
                <p className="text-xs text-text-muted">Remote access</p>
              </div>
              <p className="text-2xl font-semibold">
                {security.tunnelEnabled || security.tailscaleEnabled ? "On" : "Off"}
              </p>
              <Link href="/dashboard/endpoint" className="text-xs text-primary mt-2 inline-block hover:underline">
                Endpoint settings
              </Link>
            </Card>
          </>
        )}
      </div>

      <div>
        <h2 className="text-sm font-semibold text-text-main mb-3">Quick links</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {QUICK_LINKS.map((link) => (
            <Link key={link.href} href={link.href}>
              <Card padding="sm" className="h-full hover:border-primary/40 hover:shadow-[var(--shadow-warm)] transition-all">
                <div className="flex items-start gap-3">
                  <span className="material-symbols-outlined text-primary text-[20px]">{link.icon}</span>
                  <div>
                    <p className="text-sm font-medium">{link.label}</p>
                    <p className="text-xs text-text-muted mt-0.5">{link.desc}</p>
                  </div>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      </div>

      <Card padding="sm" className="bg-primary/5 border-primary/20">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium">Ready to connect a coding tool?</p>
            <p className="text-xs text-text-muted mt-0.5">Copy your endpoint URL and API key from the Endpoint page.</p>
          </div>
          <Link href="/dashboard/endpoint">
            <Button variant="primary" size="sm">Open Endpoint</Button>
          </Link>
        </div>
      </Card>
    </div>
  );
}
